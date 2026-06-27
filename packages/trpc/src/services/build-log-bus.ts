/**
 * In-memory build-log bus (epic: git-cicd-registry, PHASE-2).
 *
 * Build output streams from the agent as `logChunk`s keyed by the build's
 * `commandId` (== `Build.logsRef`). The gateway already routes those chunks into
 * `store.logEvent`; a tiny bridge in apps/api forwards them here, keyed by build
 * id, so the live build-log viewer can subscribe/poll over tRPC without the
 * services layer needing the gateway's `AgentHub` internals.
 *
 * It keeps a bounded ring per build (so a late-opening viewer still gets recent
 * scrollback) plus a pub/sub for live tailing. Pure infra — no DB, org-scoping
 * is enforced by the caller (build id is resolved against the org first).
 */
import type { LogLine } from '@swarmy/core/views';

const MAX_LINES_PER_BUILD = 2000;
const MAX_BUILDS = 256;

type Listener = (line: LogLine) => void;

interface BuildLog {
  lines: LogLine[];
  listeners: Set<Listener>;
  done: boolean;
}

class BuildLogBus {
  private builds = new Map<string, BuildLog>();

  private ensure(buildId: string): BuildLog {
    let b = this.builds.get(buildId);
    if (!b) {
      // Evict the oldest build if we are over the cap.
      if (this.builds.size >= MAX_BUILDS) {
        const oldest = this.builds.keys().next().value;
        if (oldest) this.builds.delete(oldest);
      }
      b = { lines: [], listeners: new Set(), done: false };
      this.builds.set(buildId, b);
    }
    return b;
  }

  /** Append a chunk; called by the gateway bridge. `eof` finalizes the stream. */
  push(buildId: string, line: LogLine, eof = false): void {
    const b = this.ensure(buildId);
    if (line.message) {
      b.lines.push(line);
      if (b.lines.length > MAX_LINES_PER_BUILD) b.lines.shift();
      for (const fn of [...b.listeners]) fn(line);
    }
    if (eof) b.done = true;
  }

  /** Mark a build's log stream finished (build succeeded/failed). */
  finish(buildId: string): void {
    const b = this.builds.get(buildId);
    if (b) b.done = true;
  }

  /** Current scrollback for a build (for the historical `logsPage` query). */
  snapshot(buildId: string): { lines: LogLine[]; done: boolean } {
    const b = this.builds.get(buildId);
    return { lines: b ? [...b.lines] : [], done: b?.done ?? false };
  }

  /** Subscribe to live lines (no replay; pair with `snapshot` for scrollback). */
  subscribe(buildId: string, fn: Listener): () => void {
    const b = this.ensure(buildId);
    b.listeners.add(fn);
    return () => b.listeners.delete(fn);
  }

  isDone(buildId: string): boolean {
    return this.builds.get(buildId)?.done ?? false;
  }
}

/** Process-wide singleton shared by the gateway bridge and the cicd router. */
export const buildLogBus = new BuildLogBus();
