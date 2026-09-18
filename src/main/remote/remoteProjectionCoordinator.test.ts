import Database from 'better-sqlite3';
import { build } from 'esbuild';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initializeLibraryTables } from '../library/libraryMigrations';
import { RemoteStore } from './remoteStore';

const workerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-projection-test-worker-'));
const workerPath = path.join(workerDirectory, 'worker.cjs');
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  await build({ entryPoints: [path.join(__dirname, 'remoteProjectionWorker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: workerPath,
    plugins: [{ name: 'native-sqlite', setup(builder) { builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true })); } }] });
});
afterAll(() => fs.rmSync(workerDirectory, { recursive: true, force: true }));
const owner = { userId: 'A', scopeKey: 'personal' };
const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });
function fixture(disk = true, withArtifacts = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-isolation-'));
  dispose.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new Database(disk ? path.join(directory, 'core.sqlite') : ':memory:'); dispose.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  if (withArtifacts) initializeLibraryTables(db);
  const store = new RemoteStore(db, { deferredProjection: true, projectionWorkerPath: workerPath }); store.setEnabledOwner(owner);
  store.transaction(() => {
    db.exec("INSERT INTO cowork_sessions VALUES('task','Task',1,1,'idle')"); store.assignNew('task', owner, 'local_create');
    db.exec("INSERT INTO cowork_messages VALUES('message','task','assistant','Original','{}',1,1)");
  });
  return { store, db, directory };
}

function addArtifact(db: Database.Database, id: string, sessionId: string, messageId: string): void {
  db.prepare(`INSERT INTO library_local_artifacts
    (id,path_key,file_path,file_name,extension,artifact_type,category,size_bytes,sort_time_ms,first_seen_at,last_seen_at,last_verified_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'markdown','text',12,1,1,1,1,1,1)`).run(id, `/private/${id}.md`, `/private/${id}.md`, `${id}.md`, 'md');
  db.prepare(`INSERT INTO library_artifact_sessions
    (artifact_id,session_id,relation_kind,first_related_at,last_related_at,last_message_id,created_at,updated_at)
    VALUES (?,?,'created',1,1,?,1,1)`).run(id, sessionId, messageId);
}

describe('desktop core and remote projection isolation', () => {
  it('commits local messages before any worker projection and publishes off-thread', async () => {
    const f = fixture();
    expect(f.store.sync('task')?.source_seq).toBe(0);
    expect(f.store.snapshot('task').records).toEqual([]);
    expect(f.db.prepare('SELECT content FROM cowork_messages').get()).toEqual({ content: 'Original' });
    await f.store.flushProjections();
    expect(f.store.snapshot('task').records.find(row => row.payload.message)?.payload.message.blocks[0].text).toBe('Original');
    expect(f.store.sync('task')!.source_seq).toBeGreaterThan(0);
    expect(f.db.prepare('SELECT * FROM remote_dirty').all()).toEqual([]);
    expect(fs.readdirSync(path.join(f.directory, 'remote-projection-staging'))).toEqual([]);
  });
  it('does not roll back a local mutation when a malformed projection fails', async () => {
    const f = fixture(); await f.store.flushProjections();
    f.db.prepare("UPDATE remote_projection SET record_json='{' WHERE object_key='message:message'").run();
    f.store.transaction(() => f.db.prepare("UPDATE cowork_messages SET content='Updated' WHERE id='message'").run());
    await f.store.flushProjections();
    expect(f.db.prepare('SELECT content FROM cowork_messages').get()).toEqual({ content: 'Updated' });
    expect(f.db.prepare('SELECT reason FROM remote_projection_failures WHERE session_id=?').get('task')).toBeTruthy();
    expect(f.db.prepare('SELECT 1 FROM remote_dirty').get()).toBeTruthy();
    expect(fs.readdirSync(path.join(f.directory, 'remote-projection-staging'))).toEqual([]);
  });
  it('rebuilds missing bodies without reusing reserved sequences or losing object identity', async () => {
    const f = fixture(); await f.store.flushProjections();
    const first = f.store.snapshot('task').records.find(row => row.payload.message)!.payload.message;
    const high = f.store.sync('task')!.source_seq + 20;
    f.db.prepare('UPDATE remote_sync SET source_seq=? WHERE local_id=?').run(high, 'task');
    f.db.prepare('INSERT INTO remote_projection_publications VALUES (?,?,?,?,?)').run('task', path.join(f.directory, 'missing.sqlite'), high, 1, 'missing');
    f.db.exec('DELETE FROM remote_projection; DELETE FROM remote_outbox; INSERT OR IGNORE INTO remote_dirty VALUES(\'task\')');
    await f.store.flushProjections();
    const rebuilt = f.store.snapshot('task').records.find(row => row.payload.message)!.payload.message;
    expect(rebuilt.ordinal).toBe(first.ordinal); expect(rebuilt.runId).toBe(first.runId); expect(rebuilt.commandId).toBe(first.commandId);
    expect(Number(rebuilt.revision)).toBeGreaterThan(Number(first.revision));
    expect(f.store.sync('task')!.source_seq).toBeGreaterThan(high);
    expect(f.store.sync('task')!.ack_seq).toBe(0); expect(f.store.sync('task')!.needs_snapshot).toBe(1);
    expect(f.store.pending('task').every(event => Number(event.sourceSeq) > high)).toBe(true);
  });
  it('keeps disabled synchronization as durable dirtiness without projecting or advancing source sequences', async () => {
    const f = fixture(); f.store.setEnabledOwner(null);
    f.store.transaction(() => f.db.prepare("UPDATE cowork_messages SET content='Offline' WHERE id='message'").run());
    await f.store.flushProjections();
    expect(f.store.sync('task')?.source_seq).toBe(0); expect(f.db.prepare('SELECT * FROM remote_dirty').all()).toHaveLength(1);
    f.store.setEnabledOwner(owner); await f.store.flushProjections();
    expect(f.store.snapshot('task').records.find(row => row.payload.message)?.payload.message.blocks[0].text).toBe('Offline');
  });
  it('projects real library foreign keys in a disk worker without copying unrelated task artifacts', async () => {
    const f = fixture(true, true);
    expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(f.db.pragma('foreign_key_list(library_artifact_sessions)')).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'library_local_artifacts' }), expect.objectContaining({ table: 'cowork_sessions' }),
    ]));
    f.store.transaction(() => {
      addArtifact(f.db, 'report', 'task', 'message');
      f.db.exec("INSERT INTO cowork_sessions VALUES('other','Other',1,1,'idle')");
      f.store.assignNew('other', { userId: 'B', scopeKey: 'personal' }, 'local_create');
      addArtifact(f.db, 'other-private', 'other', 'other-message');
    });
    const artifacts = f.db.prepare('SELECT * FROM library_local_artifacts ORDER BY id').all();
    const relations = f.db.prepare('SELECT * FROM library_artifact_sessions ORDER BY artifact_id').all();
    await f.store.flushProjections();
    expect(f.db.prepare('SELECT * FROM remote_projection_failures').all()).toEqual([]);
    const message = f.store.snapshot('task').records.find(row => row.payload.message)?.payload.message;
    expect(message?.blocks).toContainEqual(expect.objectContaining({ type: 'artifact', artifactId: 'report', name: 'report.md' }));
    expect(JSON.stringify(message)).not.toContain('other-private');
    expect(JSON.stringify(message)).not.toContain('/private/');
    expect(f.db.prepare('SELECT * FROM library_local_artifacts ORDER BY id').all()).toEqual(artifacts);
    expect(f.db.prepare('SELECT * FROM library_artifact_sessions ORDER BY artifact_id').all()).toEqual(relations);
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('automatically clears an expired projection failure after rebuilding with the real library schema', async () => {
    const f = fixture(true, true);
    f.store.transaction(() => addArtifact(f.db, 'report', 'task', 'message'));
    f.store.recordProjectionFailure('task', 'no such table: main.library_local_artifacts');
    f.db.prepare('UPDATE remote_projection_failures SET retry_at=0 WHERE session_id=?').run('task');
    expect(f.db.prepare('SELECT content FROM cowork_messages WHERE id=?').get('message')).toEqual({ content: 'Original' });
    await f.store.flushProjections();
    expect(f.db.prepare('SELECT * FROM remote_projection_failures').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM remote_dirty').all()).toEqual([]);
    expect(f.store.sync('task')!.source_seq).toBeGreaterThan(0);
    expect(f.store.snapshot('task').records.find(row => row.payload.message)?.payload.message.blocks[0].text).toBe('Original');
    expect(fs.readdirSync(path.join(f.directory, 'remote-projection-staging'))).toEqual([]);
  });
  it('projects a task when the initialized library has no artifact relations', async () => {
    const f = fixture(true, true);
    await f.store.flushProjections();
    expect(f.db.prepare('SELECT * FROM remote_projection_failures').all()).toEqual([]);
    expect(f.store.snapshot('task').records.find(row => row.payload.message)?.payload.message.blocks).toEqual([{ type: 'markdown', text: 'Original' }]);
  });
  it('isolates a corrupt remote display cache and preserves corrupt execution evidence on startup', async () => {
    const f = fixture(false);
    f.db.prepare('INSERT INTO remote_state VALUES (?,?)').run('replyProjectionMode', '{');
    f.db.prepare('INSERT INTO remote_state VALUES (?,?)').run('run:task', '{');
    let reopened!: RemoteStore;
    expect(() => { reopened = new RemoteStore(f.db, { deferredProjection: true }); }).not.toThrow();
    await reopened.waitRunRecovery();
    expect(reopened.needsSecurityRecovery()).toBe(true);
    expect(reopened.owner('task')).toEqual(owner);
    expect(() => reopened.run('task')).toThrow();
    expect(f.db.prepare('SELECT key FROM remote_corrupt_state ORDER BY key').all()).toEqual([{ key: 'replyProjectionMode' }, { key: 'run:task' }]);
    expect(() => reopened.transaction(() => f.db.prepare("UPDATE cowork_sessions SET title='Still editable' WHERE id='task'").run())).not.toThrow();
  });
});
