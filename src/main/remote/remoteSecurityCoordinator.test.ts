import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { RemoteIdentity } from './installationIdentity';
import { RemoteSecurityCoordinator } from './remoteSecurityCoordinator';
import { RemoteSecurityJournal, type RemoteSecurityJournalIo } from './remoteSecurityJournal';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'A', scopeKey: 'personal' };
const identity: RemoteIdentity = { installationId: 'install', databaseId: 'database', deviceKey: Buffer.alloc(32, 3).toString('base64url') };
class MemoryIo implements RemoteSecurityJournalIo {
  current: string | null = null; previous: string | null = null; writes = 0; failWrite = 0;
  async read() { return { current: this.current, previous: this.previous }; }
  async replace(expected: string | null, content: string): Promise<void> {
    if (expected !== this.current) throw new Error('compare and swap failed');
    this.writes++; if (this.failWrite === this.writes) throw new Error('injected disk failure');
    this.previous = this.current; this.current = content;
  }
  close(): void {}
}
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  let store = new RemoteStore(db, { deferredProjection: true }); const io = new MemoryIo();
  const create = (id: string): void => store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES (?,'Task',1,1,'idle')").run(id); store.assignNew(id, owner, 'local_create');
  });
  const security = () => new RemoteSecurityCoordinator(store, new RemoteSecurityJournal(identity, io, true), identity, 0);
  return { db, io, create, security, store: () => store, reopen: () => { store = new RemoteStore(db, { deferredProjection: true }); } };
}

describe('remote execution durability stays outside ordinary desktop writes', () => {
  it('signs owned tasks and never writes the external journal for ordinary messages', async () => {
    const f = fixture(); f.create('task'); const security = f.security(); await security.available();
    const before = f.io.writes;
    for (let index = 0; index < 50; index++) f.store().transaction(() => f.db.prepare('UPDATE cowork_sessions SET title=? WHERE id=?').run(`Title ${index}`, 'task'));
    expect(f.io.writes).toBe(before); expect(f.store().owner('task')).toEqual(owner);
    expect(f.store().get('ownershipProof:task')).toBeTruthy();
    await security.commit('command', { type: 'execute', owner }, () => f.store().put('inbox:command', { state: 'executing' }));
    expect(f.io.writes).toBe(before + 2); expect(f.store().get('securityJournalHead')).toMatchObject({ operationId: 'command', sequence: 1 });
  });
  it('preserves same-installation tasks created while secure storage is temporarily unavailable', async () => {
    const f = fixture(); await f.security().available(); f.reopen(); f.create('offline-created');
    expect(f.store().get('ownershipProof:offline-created')).toBeNull();
    expect(f.db.prepare('SELECT database_id FROM remote_ownership_pending').get()).toEqual({ database_id: identity.databaseId });
    await f.security().available();
    expect(f.store().owner('offline-created')).toEqual(owner); expect(() => f.store().assertActor('offline-created', owner)).not.toThrow();
    expect(f.store().get('ownershipProof:offline-created')).toBeTruthy(); expect(f.db.prepare('SELECT * FROM remote_ownership_pending').all()).toEqual([]);
  });
  it('does not silently sign a pending task created under a different installation', async () => {
    const f = fixture(); await f.security().available(); f.reopen(); f.create('unverified');
    f.db.prepare("UPDATE remote_ownership_pending SET database_id='other-installation'").run();
    await expect(f.security().available()).rejects.toThrow('unverified installation');
    expect(f.store().owner('unverified')).toEqual(owner); expect(f.store().get('ownershipProof:unverified')).toBeNull();
    expect(f.store().needsSecurityRecovery()).toBe(true);
  });
  it('recovers committed-core / pending-external finalization without re-executing a command', async () => {
    const f = fixture(); f.create('task'); const security = f.security(); await security.available();
    f.io.failWrite = f.io.writes + 2;
    await expect(security.commit('command', { type: 'execute' }, () => f.store().put('inbox:command', { state: 'executing' }))).rejects.toThrow('disk failure');
    expect(f.store().owner('task')).toEqual(owner); expect(f.store().needsSecurityRecovery()).toBe(true);
    f.io.failWrite = 0; f.reopen(); await f.security().available();
    expect(f.store().get('inbox:command')).toEqual({ state: 'executing' });
    expect(f.store().owner('task')).toEqual(owner); expect(f.store().needsSecurityRecovery()).toBe(false);
  });
  it('treats a predecessor core plus pending external record as unknown, preserving local ownership', async () => {
    const f = fixture(); f.create('task'); const security = f.security(); await security.available();
    f.io.failWrite = f.io.writes + 2;
    await expect(security.commit('command', { type: 'execute' }, () => f.store().put('inbox:command', { state: 'executing' }))).rejects.toThrow();
    // Simulate restoration to a pre-commit backup, not evidence that the side effect never happened.
    f.store().remove('securityJournalHead'); f.store().remove('inbox:command'); f.io.failWrite = 0; f.reopen();
    await expect(f.security().available()).rejects.toThrow('explicit recovery');
    expect(f.store().owner('task')).toEqual(owner); expect(f.store().hasCompleteExecutionHistory()).toBe(false);
  });
});
