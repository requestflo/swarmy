/**
 * Paths inside a volume backup. Dependency-free on purpose: the wire schema
 * (`protocol/snapshot-dump.ts`) and the browser-safe download rules
 * (`snapshot-download.ts`) both import it.
 */

/** Where a volume backup keeps the volume's files inside the snapshot (the agent's mount). */
export const SNAPSHOT_DATA_ROOT = '/data';

/**
 * An absolute path inside a volume snapshot: `/data` or `/data/<segments>`.
 * No `.`/`..`/empty segments and no control characters, so it can never step
 * outside the snapshot's volume or read as an option (it starts with `/`).
 */
export const SNAPSHOT_PATH_RE = /^\/data(?:\/(?!\.\.?(?:\/|$))[^/\x00-\x1f\x7f]+)*$/;
