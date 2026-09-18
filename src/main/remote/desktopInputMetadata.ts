import { promises as fs } from 'fs';
import path from 'path';

import type { CoworkImageAttachmentPayload } from '../../shared/cowork/imageAttachments';
import type { CoworkLocalInput } from '../../shared/cowork/inputAttachments';
import type { RemoteOwner } from '../../shared/remote/constants';
import { remoteFileLocalLimit,RemoteFileReason } from '../../shared/remote/files';
import { RemoteInputIntent } from '../../shared/remote/input';
import { captureRemoteFileSnapshot, type RemoteFileSnapshot, writeRemoteTemporaryInput } from './remoteFileSnapshots';

export interface DesktopInputSource {
  path: string; fileName: string; mimeType: string; intent: 'file' | 'image'; sizeBytes: string;
  fileIdentity: { dev: string; ino: string; sizeBytes: string; mtimeMs: number };
  snapshot?: RemoteFileSnapshot;
  captureReason?: string;
}
export interface DesktopInputRun { owner: RemoteOwner; text: string; attachments: DesktopInputSource[] }
const mimeTypes: Record<string, string> = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

/** Captures selected files only. Network upload runs independently after message synchronization. */
export async function captureDesktopInput(input: CoworkLocalInput | undefined, images: CoworkImageAttachmentPayload[] | undefined,
  deps: { owner: RemoteOwner; fallbackText: string; cacheRoot: string; captureSnapshot?: boolean; current(): boolean; access(filePath: string): { assertAllowed(): void } }): Promise<DesktopInputRun | null> {
  if (!input && !images?.length) return null;
  const attachments: DesktopInputSource[] = [];
  let capturedBytes = 0, capturedImages = 0, capturedCount = 0;
  const temporary = new Set<string>();
  const selected = Array.isArray(input?.attachments) ? input.attachments.slice(0, 20) : [];
  const candidates = [...selected];
  for (const image of images || []) {
    if (image.role) continue;
    let filePath = image.localPath;
    // These are the same immutable IPC bytes given to the engine, not a later version of its mutable path.
    if (deps.captureSnapshot && image.base64Data && image.base64Data.length <= 14_000_000 && deps.current()) {
      try {
        filePath = await writeRemoteTemporaryInput(deps.cacheRoot, deps.owner, image.base64Data,
          () => { if (!deps.current()) throw new Error('ACCESS_DENIED'); });
        temporary.add(filePath);
        const index = candidates.findIndex(item => item.path === image.localPath);
        if (index >= 0) candidates.splice(index, 1);
      } catch { /* Preserve local-only metadata when immutable capture is unavailable. */ }
    }
    if (filePath && !candidates.some(item => item.path === filePath)) candidates.push({ path: filePath, name: image.name, intent: RemoteInputIntent.Image });
    else if (!filePath && image.base64Data && attachments.length < 20) {
      const sizeBytes = String(Math.max(0, Math.floor(image.base64Data.length * 3 / 4) - (image.base64Data.endsWith('==') ? 2 : image.base64Data.endsWith('=') ? 1 : 0)));
      attachments.push({ path: '', fileName: path.basename(image.name.replace(/\\/gu, '/')).slice(0, 255),
        mimeType: image.mimeType || 'application/octet-stream', intent: RemoteInputIntent.Image, sizeBytes,
        fileIdentity: { dev: '0', ino: '0', sizeBytes, mtimeMs: 0 } });
    }
  }
  try { for (const candidate of candidates.slice(0, Math.max(0, 20 - attachments.length))) {
    if (!deps.current()) return null;
    if (typeof candidate.path !== 'string' || !path.isAbsolute(candidate.path) || typeof candidate.name !== 'string') continue;
    try {
      const lease = deps.access(candidate.path);
      const file = await fs.stat(candidate.path); lease.assertAllowed();
      if (!deps.current()) return null;
      if (!file.isFile() || file.size > 100 * 1024 * 1024) continue;
      const image = images?.find(value => value.localPath === candidate.path || value.name === candidate.name);
      const localLimit = remoteFileLocalLimit(candidate.name, false);
      const mayCapture = deps.captureSnapshot && temporary.has(candidate.path) && localLimit !== null && file.size <= localLimit && capturedCount < 10
        && capturedBytes + file.size <= 100 * 1024 * 1024 && (candidate.intent !== RemoteInputIntent.Image || capturedImages + file.size <= 20 * 1024 * 1024);
      let snapshot: RemoteFileSnapshot | undefined;
      let captureReason: string | undefined;
      if (mayCapture) {
        try {
          snapshot = await captureRemoteFileSnapshot(candidate.path, deps.cacheRoot, deps.owner, localLimit!,
            () => { if (!deps.current()) throw new Error('ACCESS_DENIED'); lease.assertAllowed(); });
        } catch (error) {
          // A remote cache failure must not erase the attachment from the message projection.
          const reason = error instanceof Error ? error.message : '';
          captureReason = Object.values(RemoteFileReason).some(value => value === reason) ? reason : RemoteFileReason.Source;
        }
      } else if (deps.captureSnapshot) {
        captureReason = localLimit === null ? RemoteFileReason.Type
          : file.size > localLimit || temporary.has(candidate.path) ? RemoteFileReason.Size : RemoteFileReason.Source;
      }
      if (!deps.current()) {
        if (snapshot) await fs.rm(snapshot.path, { force: true }).catch((): void => undefined);
        return null;
      }
      if (snapshot) { capturedBytes += file.size; capturedCount++; if (candidate.intent === RemoteInputIntent.Image) capturedImages += file.size; }
      attachments.push({ path: candidate.path, fileName: path.basename(candidate.name.replace(/\\/gu, '/')).slice(0, 255), ...(snapshot ? { snapshot } : {}),
        ...(captureReason ? { captureReason } : {}),
        mimeType: image?.mimeType || mimeTypes[path.extname(candidate.path).toLowerCase()] || 'application/octet-stream',
        intent: candidate.intent === RemoteInputIntent.Image ? RemoteInputIntent.Image : RemoteInputIntent.File, sizeBytes: String(file.size),
        fileIdentity: { dev: String(file.dev), ino: String(file.ino), sizeBytes: String(file.size), mtimeMs: file.mtimeMs } });
    } catch { /* Local execution retains its selected paths; an unavailable file is not uploaded. */ }
  } } finally {
    for (const file of temporary) await fs.rm(file, { force: true }).catch((): void => undefined);
    if (!deps.current()) for (const source of attachments) if (source.snapshot) await fs.rm(source.snapshot.path, { force: true }).catch((): void => undefined);
  }
  return { owner: deps.owner, text: typeof input?.text === 'string' ? input.text : deps.fallbackText, attachments };
}
