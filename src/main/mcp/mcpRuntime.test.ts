import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CoworkIpcChannel } from '../../shared/cowork/constants';
import { submitCoworkPermission } from '../coworkPermissionIpc';
import type { CoworkRuntime, PermissionResult } from '../libs/agentEngine/types';
import { type AskUserResponse, AskUserResponseReason, McpBridgeServer } from '../libs/mcpBridgeServer';
import type { SqliteStore } from '../sqliteStore';
import { McpRuntime } from './mcpRuntime';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] },
}));
vi.mock('../computerUse/computerUseKit', () => ({ isComputerUseKitInstalled: vi.fn() }));
vi.mock('../computerUse/computerUseMcpServer', () => ({ resolveComputerUseMcpServer: vi.fn() }));
vi.mock('../computerUse/computerUseRuntime', () => ({ installComputerUseRuntime: vi.fn() }));
vi.mock('../libs/coworkUtil', () => ({ getElectronNodeRuntimePath: vi.fn() }));
vi.mock('../libs/resolveStdioCommand', () => ({ resolveStdioCommand: vi.fn() }));
vi.mock('./mcpLaunchResolverManager', () => ({ McpLaunchResolverManager: vi.fn() }));
vi.mock('./mcpStore', () => ({ McpStore: vi.fn() }));
vi.mock('../libs/openclawLocalSessionResolver', () => ({
  resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey: (_db: unknown, key: string) => (
    key === 'agent:main:lobsterai:session-a' ? 'session-a' : null
  ),
}));

const questions = [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }];
const sessionKey = 'agent:main:lobsterai:session-a';

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset();
  // Use the real question bridge and timers without binding a local HTTP port.
  vi.spyOn(McpBridgeServer.prototype, 'start').mockResolvedValue(1234);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture() {
  const permissionSessions = new Map<string, string>();
  const requested = vi.fn();
  const dismissed = vi.fn();
  const runtime = new McpRuntime({
    permissionSessions,
    getStore: () => ({ getDatabase: () => ({}) }) as unknown as SqliteStore,
    syncOpenClawConfig: vi.fn(),
    onAskUserRequested: requested,
    onAskUserDismissed: dismissed,
  });
  await runtime.startAskUserServer();
  const deps = {
    runtime: { getPermissionState: () => null } as unknown as CoworkRuntime,
    sessionForRequest: (id: string) => permissionSessions.get(id),
    isRuntimeRequest: () => false,
    canAccessSession: vi.fn((id: string) => id === 'session-a'),
    accountKey: () => 'account-a',
    resolveQuestion: vi.fn((id: string, result: PermissionResult) => {
      const response: AskUserResponse = {
        behavior: result.behavior,
        answers: result.behavior === 'allow' ? result.updatedInput?.answers as Record<string, string> : undefined,
      };
      if (!runtime.resolveAskUser(id, response)) throw new Error('QUESTION_UNAVAILABLE');
    }),
  };
  return { runtime, permissionSessions, requested, dismissed, deps };
}

describe('AskUserQuestion creation to IPC response', () => {
  test.each(['allow', 'deny'] as const)('registers the session before showing a question and submits %s', async behavior => {
    const { runtime, permissionSessions, requested, dismissed, deps } = await fixture();
    send.mockImplementation((channel: string, payload: { request?: { requestId: string } }) => {
      if (channel === CoworkIpcChannel.StreamPermission) {
        expect(permissionSessions.get(payload.request!.requestId)).toBe('session-a');
      }
    });
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey });
    const requestId = requested.mock.calls[0][1].requestId as string;
    const result = { behavior, updatedInput: { answers: { Continue: 'Yes' } } };
    await expect(submitCoworkPermission({ requestId, result }, deps)).resolves.toEqual({ kind: 'question_resolved' });
    await expect(response).resolves.toEqual({ behavior, answers: behavior === 'allow' ? result.updatedInput.answers : undefined });
    expect(permissionSessions.has(requestId)).toBe(false);
    expect(dismissed).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(send).toHaveBeenCalledWith(CoworkIpcChannel.StreamPermissionDismiss, { requestId });
    expect(runtime.resolveAskUser(requestId, { behavior })).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  test('account access denial does not consume or resolve the pending question', async () => {
    const { runtime, permissionSessions, requested, deps } = await fixture();
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey });
    const requestId = requested.mock.calls[0][1].requestId as string;
    deps.canAccessSession.mockReturnValue(false);
    await expect(submitCoworkPermission({ requestId, result: { behavior: 'allow' } }, deps))
      .rejects.toThrow('APPROVAL_ACCESS_DENIED');
    expect(deps.resolveQuestion).not.toHaveBeenCalled();
    expect(permissionSessions.get(requestId)).toBe('session-a');
    runtime.resolveAskUser(requestId, { behavior: 'deny' });
    await expect(response).resolves.toMatchObject({ behavior: 'deny' });
  });

  test('timeout removes session ownership, dismisses the dialog, and rejects a late submission', async () => {
    const { runtime, permissionSessions, requested, dismissed, deps } = await fixture();
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey });
    const requestId = requested.mock.calls[0][1].requestId as string;
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(response).resolves.toMatchObject({ behavior: 'deny', reason: AskUserResponseReason.Timeout });
    expect(permissionSessions.has(requestId)).toBe(false);
    expect(dismissed).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(send).toHaveBeenCalledWith(CoworkIpcChannel.StreamPermissionDismiss, { requestId });
    await expect(submitCoworkPermission({ requestId, result: { behavior: 'allow' } }, deps))
      .rejects.toThrow('APPROVAL_ACCESS_DENIED');
    expect(deps.resolveQuestion).not.toHaveBeenCalled();
    expect(runtime.resolveAskUser(requestId, { behavior: 'allow' })).toBe(false);
  });

  test('unrecognized desktop sessions cannot create a visible question or ownership record', async () => {
    const { runtime, permissionSessions, requested } = await fixture();
    await expect(runtime.askUserInternal(questions, 1_000, { sessionKey: 'unknown' }))
      .resolves.toMatchObject({ behavior: 'deny' });
    expect(permissionSessions.size).toBe(0);
    expect(requested).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([channel]) => channel === CoworkIpcChannel.StreamPermission)).toBe(false);
  });
});
