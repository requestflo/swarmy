import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reads a terminal session recording (asciicast v2 `.cast` file) back for the
 * replay endpoint. Recordings are written by the controller data plane
 * (apps/api TerminalRecorder) under `SWARMY_TERM_RECORDING_DIR`; the tRPC
 * recording endpoint runs in the same controller process, so it reads the same
 * local sink. The `recordingRef` indirection lets the volumes/object-store epic
 * later swap this for blob storage.
 *
 * Access is RBAC-gated upstream (admins/owner or the actor) in the router.
 */
const RECORDING_DIR = process.env.SWARMY_TERM_RECORDING_DIR ?? '.swarmy/recordings';

export async function readRecording(ref: string): Promise<string | null> {
  // Guard against path traversal in the stored ref.
  const safeRef = ref.replace(/\.\.(\/|\\|$)/g, '');
  try {
    return await readFile(path.join(RECORDING_DIR, safeRef), 'utf8');
  } catch {
    return null;
  }
}
