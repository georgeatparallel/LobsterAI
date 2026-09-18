import {
  OpenClawQuestion,
  type OpenClawQuestionRecord,
  OpenClawQuestionStatus,
  parseOpenClawQuestionAnswers,
  parseOpenClawQuestionRecord,
} from '../../../shared/cowork/openclawQuestion';
import type { QuestionAdapterOutcome, QuestionAnswers, QuestionResponse, QuestionStatus } from '../../../shared/remote/questions';
import { stableJson } from '../../remote/canonical';
import type { PermissionRequest, PermissionResult } from './types';

type GatewayClient = {
  request: <T = Record<string, unknown>>(
    method: string, params?: unknown, options?: { timeoutMs?: number | null },
  ) => Promise<T>;
};

type ControllerOptions = {
  getGatewayClient: () => GatewayClient | null;
  resolveSessionId: (sessionKey: string, runId?: string) => string | undefined;
  isSessionStopped: (sessionId: string, sessionKey: string) => boolean;
  emitPermissionRequest: (sessionId: string, request: PermissionRequest) => void;
  emitPermissionResolved: (sessionId: string, requestId: string) => void;
  onQuestion?: (sessionId: string, record: OpenClawQuestionRecord) => void;
  onUnavailable?: (requestId: string) => void;
  onExpired?: (requestId: string) => void;
  onSettled?: (requestId: string, result: { status: Exclude<QuestionStatus, 'pending'>; answers?: QuestionAnswers }) => void;
};

type PendingQuestion = {
  record: OpenClawQuestionRecord;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
  response?: Promise<void>;
};

const RPC_TIMEOUT_MS = 10_000;
const TERMINAL_ERROR_REASONS = new Set(['QUESTION_ALREADY_TERMINAL', 'QUESTION_NOT_FOUND']);

/** Owns the native question lifecycle. It never dispatches to the legacy HTTP question bridge. */
export class OpenClawQuestionController {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly terminal = new Set<string>();
  private generation = 0;

  constructor(private readonly options: ControllerOptions) {}

  handlesRequest(requestId: string): boolean {
    return requestId.startsWith(OpenClawQuestion.RequestIdPrefix);
  }

  getPendingQuestions(): Array<PermissionRequest & { sessionId: string }> {
    const requests: Array<PermissionRequest & { sessionId: string }> = [];
    for (const [id, pending] of this.pending) {
      if (pending.record.expiresAtMs <= Date.now()) { this.expire(id); continue; }
      requests.push({
        sessionId: pending.sessionId, requestId: this.toRequestId(id),
        toolName: OpenClawQuestion.ToolName, toolInput: { ...pending.record }, toolUseId: id,
      });
    }
    return requests;
  }

  handleRequested(payload: unknown): void {
    const record = parseOpenClawQuestionRecord(payload);
    if (!record || this.terminal.has(record.id)) return;
    if (record.status !== OpenClawQuestionStatus.Pending || record.expiresAtMs <= Date.now()) {
      this.finish(record.id);
      return;
    }
    if (this.pending.has(record.id)) return;
    const sessionId = this.options.resolveSessionId(record.sessionKey, record.runId);
    // Questions owned by IM/other clients must not be assigned to the currently visible desktop task.
    if (!sessionId) return;
    if (this.options.isSessionStopped(sessionId, record.sessionKey)) {
      this.finish(record.id);
      this.cancel(record.id);
      return;
    }
    const timer = setTimeout(() => this.expire(record.id), Math.min(record.expiresAtMs - Date.now(), 2_147_483_647));
    timer.unref?.();
    this.pending.set(record.id, { record, sessionId, timer });
    // Registration is a local side channel; a broken remote projection cannot suppress native UI.
    try { this.options.onQuestion?.(sessionId, record); } catch { console.warn('[OpenClawQuestion] remote registration unavailable'); }
    this.options.emitPermissionRequest(sessionId, {
      requestId: this.toRequestId(record.id),
      toolName: OpenClawQuestion.ToolName,
      toolInput: { ...record },
      toolUseId: record.id,
    });
  }

  handleResolved(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const { id, status } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || (status !== OpenClawQuestionStatus.Answered
      && status !== OpenClawQuestionStatus.Cancelled && status !== OpenClawQuestionStatus.Expired)) return;
    const record = this.pending.get(id)?.record;
    if (record) {
      const terminal = this.terminalResult(record, payload);
      if (terminal?.status) this.notifySettled(id, terminal);
      else this.unavailable(id);
    }
    this.finish(id);
  }

  private terminalResult(record: OpenClawQuestionRecord, payload: unknown): QuestionAdapterOutcome | null {
    if (!payload || typeof payload !== 'object') return null;
    const value = payload as { status?: string; answers?: { answers?: unknown } };
    if (value.status === OpenClawQuestionStatus.Answered) {
      const answers = parseOpenClawQuestionAnswers(record.questions, value.answers?.answers);
      return answers ? { kind: 'unknown', status: value.status, answers } : null;
    }
    return value.status === OpenClawQuestionStatus.Cancelled || value.status === OpenClawQuestionStatus.Expired
      ? { kind: 'unknown', status: value.status } : null;
  }
  private notifySettled(id: string, result: QuestionAdapterOutcome): void {
    if (!result.status) return;
    try { this.options.onSettled?.(this.toRequestId(id), { status: result.status, answers: result.answers }); }
    catch { console.warn('[OpenClawQuestion] remote settlement unavailable'); }
  }

  /** Only the successful resolve RPC proves this call won. Transport/receipt loss never authorizes replay. */
  async resolveConfirmed(record: OpenClawQuestionRecord, response: QuestionResponse): Promise<QuestionAdapterOutcome> {
    const client = this.options.getGatewayClient();
    const pending = this.pending.get(record.id);
    if (!pending || stableJson(pending.record) !== stableJson(parseOpenClawQuestionRecord(record)) || !client || record.expiresAtMs <= Date.now()) {
      return { kind: 'known_not_applied', reason: 'QUESTION_UNAVAILABLE' };
    }
    const answers = response.action === 'answer' ? parseOpenClawQuestionAnswers(record.questions, response.answers) : undefined;
    if (answers === null) return { kind: 'known_not_applied', reason: 'QUESTION_INVALID_ANSWER' };
    const generation = this.generation;
    try {
      const raw = await client.request(OpenClawQuestion.Resolve, { id: record.id,
        ...(answers ? { answers: { answers } } : { cancel: true }) }, { timeoutMs: RPC_TIMEOUT_MS });
      const terminal = this.terminalResult(record, raw);
      const expected = response.action === 'answer' ? OpenClawQuestionStatus.Answered : OpenClawQuestionStatus.Cancelled;
      if (generation !== this.generation || client !== this.options.getGatewayClient() || terminal?.status !== expected
        || answers && stableJson(terminal.answers) !== stableJson(answers)) return { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' };
      this.notifySettled(record.id, terminal); this.finish(record.id);
      return { ...terminal, kind: 'confirmed' };
    } catch (error) {
      const reason = (error as { details?: { reason?: string } } | null)?.details?.reason;
      if (reason === 'QUESTION_ALREADY_TERMINAL') {
        const terminal = await this.reconcileConfirmed(record);
        return terminal.status ? { ...terminal, kind: 'known_not_applied', reason: 'QUESTION_STALE' } : terminal;
      }
      // QUESTION_NOT_FOUND may follow the 15-second receipt expiry; it is not proof of no application.
      return { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' };
    }
  }

  async reconcileConfirmed(record: OpenClawQuestionRecord): Promise<QuestionAdapterOutcome> {
    const client = this.options.getGatewayClient(), generation = this.generation;
    if (!client) return { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' };
    try {
      const result = await client.request<{ question?: unknown }>(OpenClawQuestion.Get, { id: record.id }, { timeoutMs: RPC_TIMEOUT_MS });
      const current = parseOpenClawQuestionRecord(result.question);
      if (generation !== this.generation || client !== this.options.getGatewayClient() || !current
        || stableJson({ ...current, status: record.status }) !== stableJson(parseOpenClawQuestionRecord(record))) return { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' };
      const terminal = this.terminalResult(record, result.question);
      if (!terminal) return { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' };
      this.notifySettled(record.id, terminal); this.finish(record.id); return terminal;
    } catch { return { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' }; }
  }

  /** Restore pending questions after a handshake, without replaying events resolved during the RPC. */
  async restorePending(): Promise<void> {
    const client = this.options.getGatewayClient();
    if (!client) return;
    const generation = this.generation;
    const pendingBeforeList = new Set(this.pending.keys());
    try {
      const result = await client.request<{ questions?: unknown[] }>(OpenClawQuestion.List, {}, { timeoutMs: RPC_TIMEOUT_MS });
      if (generation !== this.generation || client !== this.options.getGatewayClient() || !Array.isArray(result.questions)) return;
      const ids = new Set<string>();
      for (const record of result.questions) {
        const parsed = parseOpenClawQuestionRecord(record);
        if (parsed) ids.add(parsed.id);
        this.handleRequested(record);
      }
      for (const id of pendingBeforeList) {
        if (!ids.has(id)) { this.unavailable(id); this.finish(id); }
      }
    } catch (error) {
      if (generation === this.generation) console.warn('[OpenClawQuestion] failed to restore pending questions:', error);
    }
  }

  async respond(requestId: string, result: PermissionResult): Promise<void> {
    const id = requestId.slice(OpenClawQuestion.RequestIdPrefix.length);
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.record.expiresAtMs <= Date.now()) {
      this.finish(id);
      return;
    }
    if (pending.response) return pending.response;
    const client = this.options.getGatewayClient();
    if (!client) throw new Error('OpenClaw question gateway is disconnected');
    const answers = result.behavior === 'allow'
      ? parseOpenClawQuestionAnswers(pending.record.questions, result.updatedInput?.answers)
      : undefined;
    if (answers === null) throw new Error('Invalid OpenClaw question answers');
    const generation = this.generation;
    pending.response = (async () => {
      try {
        await client.request(OpenClawQuestion.Resolve, {
          id,
          ...(answers ? { answers: { answers } } : { cancel: true }),
        }, { timeoutMs: RPC_TIMEOUT_MS });
        if (generation === this.generation) this.finish(id);
      } catch (error) {
        const reason = (error as { details?: { reason?: string } } | null)?.details?.reason;
        if (reason && TERMINAL_ERROR_REASONS.has(reason)) {
          if (generation === this.generation) this.finish(id);
          return;
        }
        // Keep the request and the user's answers available for retry after a transport failure.
        console.warn('[OpenClawQuestion] failed to submit question response:', error);
        throw error;
      } finally {
        pending.response = undefined;
      }
    })();
    return pending.response;
  }

  cancelBySession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.finish(id);
      this.cancel(id, pending.record);
    }
  }

  /** A disconnect closes stale UI; the next handshake restores Gateway-owned pending questions. */
  disconnect(): void {
    this.generation += 1;
    for (const id of this.pending.keys()) { this.unavailable(id); this.finish(id); }
    this.terminal.clear();
  }

  private unavailable(id: string): void {
    try { this.options.onUnavailable?.(this.toRequestId(id)); } catch { console.warn('[OpenClawQuestion] remote suspension unavailable'); }
  }
  private expire(id: string): void {
    try { this.options.onExpired?.(this.toRequestId(id)); } catch { console.warn('[OpenClawQuestion] remote expiry unavailable'); }
    this.finish(id);
  }
  private cancel(id: string, record?: OpenClawQuestionRecord): void {
    const client = this.options.getGatewayClient();
    if (!client) return;
    void client.request(OpenClawQuestion.Resolve, { id, cancel: true }, { timeoutMs: RPC_TIMEOUT_MS }).then(result => {
      if (record) { const terminal = this.terminalResult(record, result); if (terminal) this.notifySettled(id, terminal); }
    }).catch((error) => {
      const reason = (error as { details?: { reason?: string } } | null)?.details?.reason;
      if (!reason || !TERMINAL_ERROR_REASONS.has(reason)) {
        console.warn('[OpenClawQuestion] failed to cancel stopped question:', error);
      }
    });
  }

  private finish(id: string): void {
    this.terminal.add(id);
    // Only retain enough tombstones to protect against late events/list responses.
    if (this.terminal.size > 1_000) this.terminal.delete(this.terminal.values().next().value!);
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.options.emitPermissionResolved(pending.sessionId, this.toRequestId(id));
  }

  private toRequestId(id: string): string {
    return `${OpenClawQuestion.RequestIdPrefix}${id}`;
  }
}
