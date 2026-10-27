import { contentDisposition } from '@swarmy/core';
import type { DownloadClaims } from '@swarmy/trpc';
import type { OpenResult } from './download-hub';
import { fileAsTar } from './tar-file';

/**
 * `GET /api/backups/download?ticket=…` (board 16): one file or folder out of a
 * volume backup, as a .tar.gz. tRPC (`backups.downloadTicket`) is the control
 * plane — `data.restore`, the path check, the cap, the audit row — and mints a
 * single-use 30 s ticket bound to the person; this route is the byte pipe. It
 * needs the same signed-in person, claims the ticket once, and streams.
 */

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** The streamed response: a file becomes a one-entry tar (restic tars folders itself), then gzip. */
export function downloadResponse(claims: DownloadClaims, body: ReadableStream<Uint8Array>): Response {
  const tar = claims.entry ? body.pipeThrough(fileAsTar(claims.entry)) : body;
  const gzip = new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>;
  return new Response(tar.pipeThrough(gzip), {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': contentDisposition(claims.fileName),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
}

export async function handleBackupDownload(
  req: Request,
  deps: {
    sessionUserId(headers: Headers): Promise<string | null>;
    open(ticket: string, userId: string): OpenResult;
  },
): Promise<Response> {
  if (req.method !== 'GET') return text(405, 'Downloads are GET only.');
  const ticket = new URL(req.url).searchParams.get('ticket');
  if (!ticket) return text(400, 'This download link is missing its ticket. Start it again from Backups.');
  const userId = await deps.sessionUserId(req.headers).catch(() => null);
  if (!userId) return text(401, 'Sign in to swarmy, then start the download again from Backups.');
  const opened = deps.open(ticket, userId);
  if (!opened.ok) return text(opened.status, opened.message);
  return downloadResponse(opened.claims, opened.body);
}
