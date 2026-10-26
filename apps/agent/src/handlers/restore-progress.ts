/**
 * Restore progress (board 40's restore card), reported only when the
 * controller asks (`DbRestorePayload.reportProgress`): `commandResult`
 * frames with `status: 'running'` and `progress.restore`, the same path a
 * deploy's image pull uses, so each one also re-arms the command's deadline.
 *
 * Sources, all lines the sidecars already print:
 *  - restic restore: `--json` status lines (restic 0.17+), or the text
 *    status line restic 0.16 prints when it is not under `--json`
 *    (`[0:05] 45.12%  12 files 1.200 GiB, total 40 files 2.600 GiB`),
 *    both paced by RESTIC_PROGRESS_FPS;
 *  - the wal-g PITR script's own `swarmy: progress base|wal N` lines
 *    (PGDATA's size while the base backup lands, WAL segments fetched).
 */
import type { CommandProgress, RestoreProgress } from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';

type Stage = RestoreProgress['stage'];
type Detail = Omit<RestoreProgress, 'stage'>;

/** One restic status line per this many seconds (`RESTIC_PROGRESS_FPS` = 1 / it). */
export const RESTIC_PROGRESS_ENV = 'RESTIC_PROGRESS_FPS=0.2';
/** The fewest milliseconds between two frames within a stage (a stage change goes at once). */
export const PROGRESS_MIN_MS = 2_000;

const UNIT: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
const bytes = (n: string, unit: string): number => Math.round(Number(n) * (UNIT[unit] ?? 1));
const TEXT_RE = /\[[\d:]+\]\s+([\d.]+)%\s+\d+ files ([\d.]+) ([KMGT]iB|B), total \d+ files ([\d.]+) ([KMGT]iB|B)/;

/** PURE: a restic restore status line → percent and bytes, or null. */
export function parseResticRestoreLine(line: string): Detail | null {
  const t = line.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { message_type?: string; percent_done?: number; bytes_restored?: number; total_bytes?: number };
      if (o.message_type !== 'status') return null;
      return {
        ...(typeof o.percent_done === 'number' ? { percent: Math.min(100, Math.max(0, o.percent_done * 100)) } : {}),
        ...(typeof o.bytes_restored === 'number' ? { bytesDone: o.bytes_restored } : {}),
        ...(typeof o.total_bytes === 'number' ? { bytesTotal: o.total_bytes } : {}),
      };
    } catch {
      return null;
    }
  }
  const m = TEXT_RE.exec(t);
  if (!m) return null;
  return { percent: Math.min(100, Number(m[1])), bytesDone: bytes(m[2]!, m[3]!), bytesTotal: bytes(m[4]!, m[5]!) };
}

/** PURE: the wal-g PITR script's progress lines → the stage and its count, or null. */
export function parseWalgPitrLine(line: string): ({ stage: Stage } & Detail) | null {
  const p = /swarmy: progress (base|wal) (\d+)/.exec(line);
  if (p) return p[1] === 'base' ? { stage: 'base', bytesDone: Number(p[2]) } : { stage: 'wal', segments: Number(p[2]) };
  const done = /swarmy: fetched (\d+) WAL segments/.exec(line);
  return done ? { stage: 'wal', segments: Number(done[1]) } : null;
}

/** PURE: restic's major.minor from an image tag (`restic/restic:0.16.4`), null when it has none. */
export function resticVersion(image: string): [number, number] | null {
  const m = /:v?(\d+)\.(\d+)/.exec(image);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * PURE: the restic restore argv. restic before 0.17 prints no progress at all
 * under `--json`, so a restore that reports progress drops it there (its
 * bytes come from `restic stats` either way); 0.17+ keeps `--json`.
 */
export function resticRestoreArgs(image: string, snapshotId: string, progress: boolean): string[] {
  const v = resticVersion(image);
  const textOnly = progress && v != null && (v[0] === 0 && v[1] < 17);
  return ['restore', snapshotId, '--target', '/', ...(textOnly ? [] : ['--json'])];
}

export interface RestoreReporter {
  /** Enter a stage (sent at once). */
  stage(stage: Stage, detail?: Detail): void;
  /** A sidecar line: a progress line moves the current stage (paced). */
  line(line: string): void;
}

/** A paced reporter over `send`. */
export function restoreReporter(send: (p: CommandProgress) => void, now: () => number = Date.now, minMs = PROGRESS_MIN_MS): RestoreReporter {
  let cur: { stage: Stage } & Detail = { stage: 'download' };
  let started = false;
  let last = 0;
  const emit = (force: boolean): void => {
    const t = now();
    if (!force && t - last < minMs) return;
    last = t;
    send({ phase: 'restoring', restore: { ...cur } });
  };
  return {
    stage(stage, detail = {}) {
      cur = { stage, ...detail };
      started = true;
      emit(true);
    },
    line(line) {
      if (!started) return;
      const walg = parseWalgPitrLine(line);
      if (walg && walg.stage !== cur.stage) {
        cur = { ...walg, ...(cur.bytesTotal != null && walg.stage === 'base' ? { bytesTotal: cur.bytesTotal } : {}) };
        return emit(true);
      }
      const d = walg ?? (cur.stage === 'download' ? parseResticRestoreLine(line) : null);
      if (!d) return;
      const { stage: _s, ...detail } = d as { stage?: Stage } & Detail;
      cur = { ...cur, ...detail };
      emit(false);
    },
  };
}

/** `running` progress frames for one command. */
export function progressSender(conn: AgentConnection, commandId: string): (p: CommandProgress) => void {
  return (progress) => conn.send('commandResult', { commandId, status: 'running', progress });
}

/** An `onLine` that also feeds the reporter (unchanged without one). */
export function withProgress(onLine: (line: string) => void, reporter: RestoreReporter | null): (line: string) => void {
  if (!reporter) return onLine;
  return (line) => {
    onLine(line);
    reporter.line(line);
  };
}
