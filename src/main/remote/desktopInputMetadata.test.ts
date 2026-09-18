import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { RemoteFileReason } from '../../shared/remote/files';
import { RemoteInputIntent } from '../../shared/remote/input';
import { captureDesktopInput } from './desktopInputMetadata';
import * as snapshots from './remoteFileSnapshots';

const folders: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'desktop-input-')); folders.push(folder);
  const filePath = path.join(folder, 'report.txt'); writeFileSync(filePath, 'fixture content');
  return { filePath, deps: { owner: { userId: 'A', scopeKey: 'personal' }, fallbackText: `Read ${filePath}`, cacheRoot: path.join(folder, 'cache'), current: () => true,
    access: vi.fn(() => ({ assertAllowed: vi.fn() })) } };
}
it('captures only explicit picker files with frozen filesystem identity', async () => {
  const { filePath, deps } = fixture();
  const result = await captureDesktopInput({ text: 'Analyze this', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined, deps);
  expect(result).toMatchObject({ text: 'Analyze this', attachments: [{ path: filePath, fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '15' }] });
  expect(result?.attachments[0].fileIdentity.ino).toMatch(/^\d+$/u);
});
it('does not infer an upload from a path appearing in prompt text', async () => {
  const { deps } = fixture();
  expect(await captureDesktopInput(undefined, undefined, deps)).toBeNull();
  expect(deps.access).not.toHaveBeenCalled();
});
it('stops metadata capture when the account generation changes after stat', async () => {
  const { filePath, deps } = fixture(); let current = true;
  const result = await captureDesktopInput({ text: 'Analyze', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, current: () => current, access: () => ({ assertAllowed: () => { current = false; } }) });
  expect(result).toBeNull();
});
it('does not grant a hidden indexed attachment permission to upload', async () => {
  const { filePath, deps } = fixture();
  const result = await captureDesktopInput({ text: 'Analyze', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, access: () => { throw new Error('hidden'); } });
  expect(result?.attachments).toEqual([]);
});

it('does not freeze a mutable picker path later and misrepresent it as the engine input', async () => {
  const { filePath, deps } = fixture();
  const result = await captureDesktopInput({ text: 'Analyze', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, captureSnapshot: true });
  expect(result?.attachments).toHaveLength(1);
  expect(result?.attachments[0].snapshot).toBeUndefined();
});

it('retains metadata for inline images when file sync is unavailable without manufacturing a source', async () => {
  const { deps } = fixture();
  const result = await captureDesktopInput(undefined, [{ name: 'pasted.png', mimeType: 'image/png', base64Data: 'aGk=' }], deps);
  expect(result?.attachments).toMatchObject([{ fileName: 'pasted.png', path: '', sizeBytes: '2', intent: 'image' }]);
  expect(result?.attachments[0].snapshot).toBeUndefined();
  expect(deps.access).not.toHaveBeenCalled();
});

it('retains image metadata when immutable snapshot storage fails and cleans its temporary input', async () => {
  const { deps } = fixture();
  vi.spyOn(snapshots, 'captureRemoteFileSnapshot').mockRejectedValue(new Error(RemoteFileReason.Final));
  const result = await captureDesktopInput(undefined,
    [{ name: 'pasted.png', mimeType: 'image/png', base64Data: 'aGk=' }], { ...deps, captureSnapshot: true });
  expect(result?.attachments).toMatchObject([{ fileName: 'pasted.png', mimeType: 'image/png', sizeBytes: '2', captureReason: RemoteFileReason.Final }]);
  expect(result?.attachments[0].snapshot).toBeUndefined();
});
it('does not retain a snapshot result after the account changes during capture', async () => {
  const { deps } = fixture(); let current = true;
  vi.spyOn(snapshots, 'captureRemoteFileSnapshot').mockImplementation(async () => { current = false; throw new Error('ACCESS_DENIED'); });
  expect(await captureDesktopInput(undefined, [{ name: 'pasted.png', mimeType: 'image/png', base64Data: 'aGk=' }],
    { ...deps, current: () => current, captureSnapshot: true })).toBeNull();
});
it('does not expose raw filesystem errors as capture failure reasons', async () => {
  const { deps } = fixture();
  vi.spyOn(snapshots, 'captureRemoteFileSnapshot').mockRejectedValue(new Error('/private/secret: permission denied'));
  const result = await captureDesktopInput(undefined,
    [{ name: 'pasted.png', mimeType: 'image/png', base64Data: 'aGk=' }], { ...deps, captureSnapshot: true });
  expect(result?.attachments[0].captureReason).toBe(RemoteFileReason.Source);
});
