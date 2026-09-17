import { expect, it, vi } from 'vitest';

import { readOpenClawSessionRecovery } from './openclawSessionRecovery';

const key = 'agent:main:lobsterai:task';
const row = { key, hasActiveRun: false, modelProvider: 'provider', model: 'new', modelOverrideSource: 'user', thinkingLevel: 'high' };
function gateway(session: Record<string, unknown> | null, receipt: Record<string, unknown> = { runId: 'run', status: 'timeout' }) {
  return { request: vi.fn(async (method: string): Promise<any> => method === 'agent.wait' ? receipt : { sessions: session ? [session] : [] }) };
}
it('reads the actual model and explicit thinking settings without patching', async () => {
  const client = gateway(row); const result = await readOpenClawSessionRecovery(client, key, 'boot');
  expect(result.configuration).toEqual({ modelOverride: 'provider/new', thinkingLevel: 'high' });
  expect(client.request).toHaveBeenCalledTimes(1); expect(client.request.mock.calls[0][0]).toBe('sessions.list');
});
it('accepts a matching durable terminal only alongside explicit inactive state', async () => {
  const client = gateway({ ...row, lastRunId: 'run', endedAt: 123, status: 'done' });
  expect((await readOpenClawSessionRecovery(client, key, 'boot', 'run')).status).toBe('succeeded');
});
it('does not mistake timeout, an absent row, a yielded run, or an unrelated run for completion', async () => {
  for (const [session, receipt] of [
    [row, { runId: 'run', status: 'timeout' }],
    [null, { runId: 'run', status: 'ok', endedAt: 123 }],
    [row, { runId: 'run', status: 'ok', endedAt: 123, yielded: true }],
    [{ ...row, lastRunId: 'new-run' }, { runId: 'run', status: 'ok', endedAt: 123 }],
    [{ ...row, hasActiveSubagentRun: true }, { runId: 'run', status: 'ok', endedAt: 123 }],
    [{ ...row, hasActiveRun: undefined }, { runId: 'run', status: 'ok', endedAt: 123 }],
  ] as const) expect((await readOpenClawSessionRecovery(gateway(session, receipt), key, 'boot', 'run')).status).toBe('unknown');
});
it('observes the running exact run and refuses to bind another active run', async () => {
  const active = { ...row, hasActiveRun: true, activeRunIds: ['run'] };
  expect((await readOpenClawSessionRecovery(gateway(active), key, 'boot', 'run')).status).toBe('running');
  expect((await readOpenClawSessionRecovery(gateway(active), key, 'boot', 'other')).status).toBe('unknown');
});
it('reads a terminal receipt before obtaining a fresh inactive session snapshot', async () => {
  const client = gateway(row, { runId: 'run', status: 'ok', endedAt: 123 });
  expect((await readOpenClawSessionRecovery(client, key, 'boot', 'run')).status).toBe('succeeded');
  expect(client.request.mock.calls.map(x => x[0])).toEqual(['agent.wait', 'sessions.list']);
});
