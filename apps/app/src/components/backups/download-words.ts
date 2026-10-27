import { bytesWords } from '@swarmy/core';
import type { Tone } from '@/components/calm';

/**
 * Words for "Download a file or folder…" (board 16). Pure: the picker's
 * crumbs, what the pick will download, and how the download is going.
 */

export interface DownloadPick {
  /** Volume-relative path; `` is the whole volume. */
  path: string;
  /** `typed`: a path typed by hand, checked when the download starts. */
  type: 'file' | 'dir' | 'typed';
  sizeBytes: string | null;
}

export interface DownloadStatus {
  state: 'ready' | 'streaming' | 'done' | 'failed' | 'canceled';
  bytes: number;
  error: string | null;
}

/** `img/2026` → the volume, `img`, `img/2026` — each a folder to go back to. */
export function folderCrumbs(path: string, volumeName: string): Array<{ name: string; path: string }> {
  const parts = path.split('/').filter(Boolean);
  return [{ name: volumeName, path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))];
}

export function sizeWords(sizeBytes: string | null): string {
  return sizeBytes == null ? '' : bytesWords(Number(sizeBytes));
}

/** What the pick will download, and whether it can (a file past the cap can't). */
export function pickWords(pick: DownloadPick, maxBytes: string): { text: string; tone: Tone; ok: boolean } {
  const cap = bytesWords(Number(maxBytes));
  const name = pick.path || 'The whole volume';
  if (pick.type === 'typed') return { text: `${name} · swarmy checks what it is when you download (up to ${cap})`, tone: 'idle', ok: true };
  if (pick.type === 'dir') {
    return { text: `${name}${pick.path ? '/' : ''} · a folder, so its size shows as it downloads (up to ${cap})`, tone: 'idle', ok: true };
  }
  const size = Number(pick.sizeBytes ?? 0);
  if (size > Number(maxBytes)) return { text: `${name} is ${bytesWords(size)}; downloads stop at ${cap}. Restore the save into a new volume instead.`, tone: 'warn', ok: false };
  return { text: `${name} · ${bytesWords(size)}`, tone: 'idle', ok: true };
}

/** How the download is going, once it has started. */
export function statusWords(s: DownloadStatus | null, fileName: string): { text: string; tone: Tone } | null {
  if (!s) return null;
  switch (s.state) {
    case 'ready':
      return { text: `Starting ${fileName}…`, tone: 'info' };
    case 'streaming':
      return { text: s.bytes > 0 ? `Downloading ${fileName} · ${bytesWords(s.bytes)} so far` : `Reading the save for ${fileName}…`, tone: 'info' };
    case 'done':
      return { text: `Downloaded ${fileName} · ${bytesWords(s.bytes)} read from the save`, tone: 'ok' };
    case 'canceled':
      return { text: s.error ?? 'The download was stopped.', tone: 'idle' };
    default:
      return { text: s.error ?? 'The download didn’t finish.', tone: 'bad' };
  }
}

export function isFinished(s: DownloadStatus | null | undefined): boolean {
  return !!s && (s.state === 'done' || s.state === 'failed' || s.state === 'canceled');
}
