import type { CoworkSessionRecoverySnapshot } from './types';

type GatewayReader = { request<T = Record<string, unknown>>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const modelRef = (provider: unknown, model: unknown): string | undefined => {
  if (typeof model !== 'string' || !model.trim()) return undefined;
  return model.includes('/') || typeof provider !== 'string' || !provider.trim() ? model.trim() : `${provider.trim()}/${model.trim()}`;
};

/** Read only. Absence, timeout, a yielded attempt, or another active run never prove completion. */
export async function readOpenClawSessionRecovery(client: GatewayReader, sessionKey: string, gatewayBootId: string,
  runId?: string): Promise<CoworkSessionRecoverySnapshot> {
  let receipt: Record<string, unknown> | null = null;
  if (runId) {
    try {
      const result = await client.request('agent.wait', { runId, timeoutMs: 1 }, { timeoutMs: 1500 });
      if (record(result) && result.runId === runId) receipt = result;
    } catch { /* Older gateways can still provide a durable, exact-run session row. */ }
  }
  // Query after the receipt: a retry/child run may have started during agent.wait.
  const result = await client.request('sessions.list', { search: sessionKey, limit: 50 }, { timeoutMs: 2000 });
  const row = Array.isArray(result.sessions) ? result.sessions.find(value => record(value) && value.key === sessionKey) : undefined;
  const snapshot: CoworkSessionRecoverySnapshot = { gatewayBootId, sessionKey, runId, status: 'unknown' };
  if (!record(row)) return snapshot;
  snapshot.hasActiveRun = row.hasActiveSubagentRun === true ? true : typeof row.hasActiveRun === 'boolean' ? row.hasActiveRun : undefined;
  const explicit = Object.prototype.hasOwnProperty.call(row, 'modelOverride');
  const sourceKnown = Object.prototype.hasOwnProperty.call(row, 'modelOverrideSource');
  const resolved = modelRef(row.modelProvider, row.model);
  const override = explicit
    ? row.modelOverride == null || row.modelOverride === '' ? '' : modelRef(row.providerOverride ?? row.modelProvider, row.modelOverride)
    : sourceKnown && row.modelOverrideSource === null ? ''
      : sourceKnown && ['user', 'auto'].includes(String(row.modelOverrideSource)) ? resolved : undefined;
  if (override !== undefined && (row.thinkingLevel == null || typeof row.thinkingLevel === 'string')) {
    snapshot.configuration = { modelOverride: override, thinkingLevel: typeof row.thinkingLevel === 'string' ? row.thinkingLevel : '' };
  }
  if (!runId) return snapshot;
  if (row.hasActiveRun === true) {
    // Do not attach an unrelated run to the old remote identity.
    if (Array.isArray(row.activeRunIds) && row.activeRunIds.includes(runId)) snapshot.status = 'running';
    return snapshot;
  }
  if (row.hasActiveRun !== false || row.hasActiveSubagentRun === true) return snapshot;
  if (typeof row.lastRunId === 'string' && row.lastRunId !== runId) return snapshot;
  if (receipt?.yielded || receipt?.pendingError) return snapshot;
  if (row.lastRunId === runId && typeof row.endedAt === 'number' && row.endedAt > 0) {
    const persisted = { done: 'succeeded', failed: 'failed', killed: 'cancelled', timeout: 'failed' } as const;
    snapshot.status = persisted[String(row.status) as keyof typeof persisted] || 'unknown';
    if (snapshot.status !== 'unknown') return snapshot;
  }
  if (receipt && !receipt.yielded && !receipt.pendingError && typeof receipt.endedAt === 'number' && receipt.endedAt > 0) {
    if (receipt.status === 'ok') snapshot.status = 'succeeded';
    else if (receipt.status === 'error') snapshot.status = /abort|cancel|supersed/iu.test(String(receipt.stopReason || '')) ? 'cancelled' : 'failed';
  }
  return snapshot;
}
