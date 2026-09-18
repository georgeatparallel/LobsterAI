import { RemoteSyncConflict } from '../../shared/remote/constants';

/** Diagnostic metadata only. Never pass raw requests, responses or errors to the logger. */
export const REMOTE_SYNC_REQUEST_ID_HEADER = 'X-Remote-Request-Id';

const SyncOperation = {
  Batch: 'batch', Begin: 'import.begin', Status: 'import.status', Part: 'import.part',
  Commit: 'import.commit', Abort: 'import.abort',
} as const;
const eventTypes = new Set(['session.upsert', 'session.deleted', 'message.upsert', 'message.delta', 'message.deleted', 'tool.upsert', 'run.updated', 'approval.updated']);
const lifecycleStates = new Set(['starting', 'running', 'waiting_approval', 'waiting_local', 'cancelling', 'reconciling', 'succeeded', 'failed', 'cancelled', 'interrupted', 'pending', 'approved', 'rejected', 'expired', 'streaming', 'complete', 'error', 'queued', 'waiting_user', 'unavailable', 'uploading', 'committed', 'aborted']);
const validationMessages = new Set([
  'Remote ACK outside durable local bounds', 'Remote batch ACK identity mismatch',
  'Remote import receipt identity mismatch', 'Import receipt identity mismatch', 'Import abortion is not confirmed',
  'REMOTE_IMPORT_BUDGET', 'REMOTE_IMPORT_RECORD_LIMIT', 'REMOTE_IMPORT_PART_UNAVAILABLE', 'REMOTE_IMPORT_CONTEXT_CHANGED',
  'Import changed the fixed remote session mapping', 'Remote response is too large',
  'Invalid remote response', 'Remote payload must contain finite JSON values',
  'Account changed during remote request', 'Account changed during remote response',
  'Object version has different content', 'Message identity and ordinal cannot change',
  'Deleted message cannot be resurrected', RemoteSyncConflict.RunMapping,
  'A source sequence cannot change content', 'Event hash mismatch',
]);
const object = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const id = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;
const sequence = (value: unknown): string | null => typeof value === 'string' && /^\d{1,19}$/u.test(value) ? value : null;
const reason = (value: unknown): string | null => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function remoteSyncRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value) ? value : null;
}

export function remoteSyncEventMetadata(raw: unknown, index: number): Record<string, unknown> {
  const event = object(raw), payload = object(event.payload);
  const entity = object(payload.message ?? payload.tool ?? payload.run ?? payload.approval ?? payload.session);
  const run = object(entity.run);
  return { index, eventType: eventTypes.has(event.eventType) ? event.eventType : 'unknown', eventId: id(event.eventId),
    sourceSeq: sequence(event.sourceSeq), objectId: id(entity.messageId ?? entity.toolCallId ?? entity.approvalId ?? entity.runId ?? entity.sessionId ?? payload.messageId),
    revision: sequence(entity.revision ?? entity.statusVersion ?? entity.approvalVersion),
    runId: id(entity.runId ?? run.runId), runStatusVersion: sequence(run.statusVersion),
    status: lifecycleStates.has(entity.status) ? entity.status : lifecycleStates.has(run.status) ? run.status : null,
    controlVersion: sequence(payload.controlVersion ?? entity.controlVersion), ordinal: sequence(entity.ordinal) };
}

export function remoteSyncRequestMetadata(pathname: string, raw: unknown): Record<string, unknown> | null {
  const route = /^\/sync\/imports\/([A-Za-z0-9_-]{1,64})(?:\/(parts\/\d+|commit|abort))?$/u.exec(pathname);
  const operation = pathname === '/sync/batches' ? SyncOperation.Batch : pathname === '/sync/imports' ? SyncOperation.Begin
    : route ? route[2]?.startsWith('parts/') ? SyncOperation.Part : route[2] === 'commit' ? SyncOperation.Commit
      : route[2] === 'abort' ? SyncOperation.Abort : SyncOperation.Status : null;
  if (!operation) return null;
  const body = object(raw), manifest = object(body.manifest);
  const records = Array.isArray(body.events) ? body.events : object(body.payload).records;
  const items = Array.isArray(records) ? records : [];
  const types: Record<string, number> = {};
  for (const record of items.slice(0, 1000)) {
    const type = object(record).eventType;
    const key = eventTypes.has(type) ? type : 'unknown';
    types[key] = (types[key] || 0) + 1;
  }
  return { operation, batchId: id(body.batchId), importId: id(body.importId ?? route?.[1]),
    localSessionId: id(body.localSessionId), sessionId: id(body.sessionId), deviceId: id(body.deviceId),
    mode: body.mode === 'online' || body.mode === 'recovery' ? body.mode : null,
    connectionGeneration: sequence(body.connectionGeneration), baseSourceSeq: sequence(body.baseSourceSeq),
    expectedSourceSeq: sequence(body.expectedSourceSeq), expectedServerSeq: sequence(body.expectedServerSeq),
    expectedStateVersion: sequence(body.expectedStateVersion), partNo: route?.[2]?.startsWith('parts/') ? count(Number(route[2].slice(6))) : null,
    partCount: count(manifest.partCount), recordCount: items.length, eventTypes: types,
    firstSourceSeq: sequence(object(items[0]).sourceSeq), lastSourceSeq: sequence(object(items.at(-1)).sourceSeq),
    ...(Array.isArray(body.events) ? { events: items.slice(0, 100).map(remoteSyncEventMetadata) } : {}) };
}

export function remoteSyncResultMetadata(raw: unknown): Record<string, unknown> {
  const result = object(raw);
  return { sessionId: id(result.sessionId), deviceId: id(result.deviceId), batchId: id(result.batchId), importId: id(result.importId),
    state: lifecycleStates.has(result.state) ? result.state : null, stateVersion: sequence(result.stateVersion),
    committedSourceSeq: sequence(result.committedSourceSeq), committedSeq: sequence(result.committedSeq) };
}

export function remoteSyncErrorMetadata(error: unknown): Record<string, any> {
  const value = object(error), details = object(value.data);
  return { code: count(value.code), httpStatus: count(value.httpStatus), reason: reason(details.reason), reasonDetail: reason(details.reasonDetail),
    requestId: remoteSyncRequestId(value.requestId) ?? remoteSyncRequestId(details.requestId),
    validation: validationMessages.has(value.message) ? value.message : null,
    errorType: ['Error', 'RemoteApiError', 'AbortError', 'TimeoutError', 'TypeError', 'SqliteError'].includes(value.name) ? value.name : 'Error',
    expectedSourceSeq: sequence(details.expectedSourceSeq), currentSourceSeq: sequence(details.currentSourceSeq),
    currentServerSeq: sequence(details.currentServerSeq), activeImportId: id(details.activeImportId) };
}
