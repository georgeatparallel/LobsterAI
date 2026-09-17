import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteInputIntent, RemoteInputMode, RemoteInputReason, type RemotePreparationClaim } from '../../shared/remote/input';
import type { CoworkStore } from '../coworkStore';
import { payloadHash } from './canonical';
import { InputPreparationService, type LocalPreparedInput } from './inputPreparationService';
import type { RemoteAgentCatalog } from './remoteAgentCatalog';
import { RemoteModelCatalog } from './remoteModelCatalog';

const owner = { userId: 'A', scopeKey: 'personal' };
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'remote-input-')); folders.push(folder);
  const cwd = path.join(folder, 'cwd'); mkdirSync(cwd);
  const values = new Map<string, unknown>();
  let actor: RemoteOwner | null = owner;
  let version = '1'; let session: any = null; let enabled = true;
  const remote = { get: <T>(key: string): T | null => values.get(key) as T ?? null,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    remove: (key: string) => values.delete(key),
    entries: (prefix: string, after = '', limit = 50) => [...values.entries()].filter(([key]) => key.startsWith(prefix) && key > after).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value })),
    owner: () => owner, localSessionId: () => session?.id, inputVersion: () => '0', controlVersion: () => '4' };
  const store = { remote, assertAgentAccess: vi.fn(), getAgent: () => ({ model: 'provider/model', thinkingLevel: 'high', enabled }),
    getSession: () => session, agentOwnership: { get: () => ({ version }), canPublish: () => !session } } as unknown as CoworkStore;
  const catalog = { refresh: vi.fn(async () => [{ agentId: 'main', version, defaultWorkspaceId: 'ws', workspaceAvailable: true }]), resolve: () => cwd } as unknown as RemoteAgentCatalog;
  const models = new RemoteModelCatalog(store.remote, () => [{ identity: 'configured-model', runtimeRef: 'provider/model', source: 'custom', displayName: 'Chat', providerLabel: 'Custom',
    available: true, image: true, toolCalling: true, thinking: { options: ['low', 'high'], default: 'low' }, configuration: {} }]);
  const deps = { store, models, cacheRoot: path.join(folder, 'cache'), getOwner: () => actor, getDefaultModel: () => 'provider/model', getAgentCatalog: () => catalog };
  const service = new InputPreparationService(deps);
  const claim: RemotePreparationClaim = { preparationId: 'prep', claimId: 'claim', claimToken: 'token', claimUntil: new Date(Date.now() + 60_000).toISOString(), statusVersion: '1',
    request: { preparationId: 'prep', inputSchemaVersion: 2, purpose: 'create_session', draftId: 'draft',
      input: { text: ' hello ', agent: { agentId: 'main', expectedVersion: '1' }, model: { mode: RemoteInputMode.Agent } } } };
  const attach = (body: string, intent: 'file' | 'image' = RemoteInputIntent.File): void => {
    claim.request.input.text = '';
    claim.request.input.attachments = [{ kind: 'uploaded_asset', assetId: 'asset', version: '1', intent }];
    claim.attachments = [{ assetId: 'asset', version: '1', intent, sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: String(Buffer.byteLength(body)), mimeType: intent === RemoteInputIntent.File ? 'text/plain' : 'image/png', fileName: 'report.txt' }];
  };
  return { service, deps, claim, attach, cwd, values, catalog,
    setActor: (next: RemoteOwner | null) => { actor = next; }, changeVersion: () => { version = '2'; }, disable: () => { enabled = false; },
    continueAnonymous: () => { session = { id: 'local', agentId: 'anon', cwd, modelOverride: 'provider/model', thinkingLevel: 'low' };
      claim.request = { ...claim.request, purpose: 'send_message', sessionId: 'remote', expectedInputVersion: '0', expectedControlVersion: '4',
        input: { text: 'continue', model: { mode: RemoteInputMode.Session } } }; } };
}
it('freezes Agent model, thinking and cwd without creating a run', async () => {
  const { service, claim, cwd, values } = fixture();
  const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true);
  expect(prepared.cwd).toBe(cwd);
  expect(prepared.resolvedInput.options).toEqual({ thinkingLevel: 'high' });
  expect(prepared.resolvedInput.text).toBe(' hello ');
  expect(prepared.inputDigest).toBe(payloadHash(prepared.resolvedInput));
  expect([...values.keys()].some(key => key.startsWith('run:'))).toBe(false);
  expect(JSON.stringify(prepared.resolvedInput)).not.toContain(cwd);
});
it('downloads an attachment only to a generated local path and reuses durable preparation', async () => {
  const { service, deps, claim, attach } = fixture(); attach('hello');
  const download = vi.fn(async () => new Response('hello'));
  const prepared = await service.prepare(owner, 'pc', claim, download, () => true);
  expect(readFileSync(prepared.files[0].path, 'utf8')).toBe('hello');
  const restarted = new InputPreparationService(deps);
  expect(await restarted.prepare(owner, 'pc', claim, download, () => true)).toEqual(prepared);
  expect(download).toHaveBeenCalledTimes(1);
  restarted.bind(prepared, 'cmd'); expect(() => restarted.bind(prepared, 'other')).toThrow(RemoteInputReason.Stale);
});
it('rejects changed content and does not save a ready manifest', async () => {
  const { service, claim, attach, values } = fixture(); attach('hello');
  await expect(service.prepare(owner, 'pc', claim, async () => new Response('other'), () => true)).rejects.toThrow(RemoteInputReason.Asset);
  expect(values.has('inputPreparation:prep')).toBe(false);
});
it('fences an account change during download including an old session generation', async () => {
  const { service, claim, attach, setActor } = fixture(); attach('hello'); let generation = 1;
  await expect(service.prepare(owner, 'pc', claim, async () => { setActor({ userId: 'B', scopeKey: 'personal' }); setActor(owner); generation++; return new Response('hello'); }, () => generation === 1)).rejects.toThrow(RemoteInputReason.Account);
});
it('keeps original cwd and allows an anonymous Agent for an owned continuation', async () => {
  const { service, claim, continueAnonymous, catalog, cwd, changeVersion } = fixture(); continueAnonymous();
  const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true);
  expect(prepared.cwd).toBe(cwd); expect(prepared.resolvedInput.agentId).toBe('anon');
  expect(prepared.resolvedInput.options.thinkingLevel).toBe('low'); expect(catalog.refresh).not.toHaveBeenCalled();
  changeVersion(); expect(() => service.validate(prepared, owner, 'pc', false)).not.toThrow();
});
it('invalidates a new preparation after default context changes without rebinding cwd', async () => {
  const { service, claim, changeVersion } = fixture();
  const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true); changeVersion();
  expect(() => service.validate(prepared, owner, 'pc', false)).toThrow(RemoteInputReason.AgentChanged);
});
it('refuses altered local assets and wrong device or identity at execution', async () => {
  const { service, claim, attach } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  expect(() => service.read('prep', owner, 'other')).toThrow(RemoteInputReason.Stale);
  expect(() => service.read('prep', { ...owner, scopeKey: 'team' }, 'pc')).toThrow(RemoteInputReason.Stale);
  writeFileSync(prepared.files[0].path, 'other');
  await expect(service.executionOptions(prepared, () => undefined)).rejects.toThrow(RemoteInputReason.Stale);
});

it('reclaims expired never-bound inputs after the delivery grace period, without a server', async () => {
  const { service, claim, attach, values } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  expect(await service.cleanupExpired(prepared.expiresAt + 60_000)).toBe(0);
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(1);
  expect(existsSync(prepared.cacheDirectory!)).toBe(false); expect(values.has('inputPreparation:prep')).toBe(false);
});
it('never removes bound task inputs, and supports expired legacy file records', async () => {
  const { service, claim, attach, values } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  service.bind(prepared, 'command');
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(0);
  expect(readFileSync(prepared.files[0].path, 'utf8')).toBe('hello');
  values.set('inputPreparation:prep', { ...prepared, boundCommandId: null, cacheDirectory: undefined });
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(1);
});
it('blocks a stale in-memory bind after cleanup claims the record and retries deletion after restart', async () => {
  const { service, deps, claim, attach, values } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const remove = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('busy'));
  const cleanup = service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000);
  expect(() => service.bind(prepared, 'command')).toThrow(RemoteInputReason.Stale);
  expect(() => service.read('prep', owner, 'pc')).toThrow(RemoteInputReason.Stale);
  expect(await cleanup).toBe(0); expect(values.get('inputPreparation:prep')).toMatchObject({ cacheCleanup: 'deleting' });
  remove.mockRestore(); warning.mockRestore();
  const restarted = new InputPreparationService(deps);
  expect(await restarted.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(1);
});
it('does not follow a symlink or remove a path outside its owned cache', async () => {
  const { service, claim, attach, values, cwd } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  const safeFile = path.join(cwd, 'keep.txt'); writeFileSync(safeFile, 'keep');
  rmSync(prepared.cacheDirectory!, { recursive: true }); symlinkSync(cwd, prepared.cacheDirectory!, 'dir');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(0);
    expect(readFileSync(safeFile, 'utf8')).toBe('keep');
    values.set('inputPreparation:prep', { ...prepared, cacheDirectory: cwd });
    expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(0);
    expect(readFileSync(safeFile, 'utf8')).toBe('keep');
  } finally { warning.mockRestore(); }
});
it('advances a bounded cleanup scan past live and bound records', async () => {
  const { service, claim, values } = fixture();
  const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true);
  values.delete('inputPreparation:prep');
  for (let i = 0; i < 55; i++) values.set(`inputPreparation:${String(i).padStart(3, '0')}`, { ...prepared, preparationId: String(i), boundCommandId: i < 50 ? 'command' : null, cacheDirectory: undefined, files: [] } as LocalPreparedInput);
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(0);
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(5);
  expect([...values.keys()].filter(key => key.startsWith('inputPreparation:'))).toHaveLength(50);
});

it('finishes cleanup when the cache root or account directory is already absent', async () => {
  for (const removeRoot of [false, true]) {
    const { service, deps, claim, attach, values } = fixture(); attach('hello');
    const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
    rmSync(removeRoot ? deps.cacheRoot : path.dirname(prepared.cacheDirectory!), { recursive: true });
    expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(1);
    expect(values.has('inputPreparation:prep')).toBe(false);
  }
});
