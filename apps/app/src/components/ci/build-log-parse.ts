/**
 * Pure readers over a build's log. The agent streams BuildKit's
 * `--progress=plain` output as chunks of whole lines (it holds a partial line
 * back until its newline arrives), so a chunk can carry several lines.
 */
export interface LogChunk {
  seq: number;
  stream: 'stdout' | 'stderr';
  message: string;
}

export interface LogLineView {
  key: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

/** Chunks → display lines (one chunk may hold many; its trailing newline ends the last). */
export function toLogLines(chunks: readonly LogChunk[]): LogLineView[] {
  const out: LogLineView[] = [];
  for (const c of chunks) {
    const parts = c.message.split(/\r?\n/);
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    for (const text of parts) out.push({ key: `${out.length}`, stream: c.stream, text });
  }
  return out;
}

const BAD_CI = /\berror(?:\(s\))?(?: [A-Z]+\d+)?:|\bfail(?:ed|ure)\b|\bfatal:/i;
const BAD_CS = /\bERROR\b/;
const WARN = /\(!\)|\bwarn(?:ing)?s?\b|\bdeprecated\b/i;

/**
 * How a line reads: an error, a warning, or plain. Judged by its words, not its
 * stream — `buildctl` writes all of its progress to stderr.
 */
export function lineTone(text: string): 'bad' | 'warn' | null {
  if (BAD_CS.test(text) || BAD_CI.test(text)) return 'bad';
  return WARN.test(text) ? 'warn' : null;
}

/** A line worth seeing under "Only warnings": warnings, deprecations and errors. */
export function isWarningLine(text: string): boolean {
  return lineTone(text) !== null;
}

export type LayerStatus = 'cached' | 'done' | 'error' | 'canceled' | 'running';

export interface BuildLayer {
  /** BuildKit's step number (`#7`). */
  id: number;
  /** The bracketed stage tag, e.g. `deps 2/2`. */
  stage: string;
  /** The Dockerfile instruction, e.g. `RUN pnpm install --frozen-lockfile`. */
  instruction: string;
  status: LayerStatus;
  seconds: number | null;
}

const STEP = /^#(\d+) (.*?)\s*$/;
const NAMED = /^\[([^\]]+)\]\s+(.+)$/;
const DONE = /^DONE (\d+(?:\.\d+)?)s$/;

/**
 * The image's build steps from BuildKit plain progress: each `#N [stage] INSTR`
 * and its outcome line (`#N CACHED`, `#N DONE 0.4s`, `#N ERROR: …`). BuildKit's
 * own bookkeeping (`[internal]`, `[auth]`, exporting, base-image resolves) is
 * not a layer and is left out — the same steps the agent's cached-step count skips.
 */
export function parseBuildLayers(text: string): BuildLayer[] {
  const steps = new Map<number, BuildLayer | null>();
  for (const line of text.split(/\r?\n/)) {
    const m = STEP.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    const rest = m[2] ?? '';
    if (!steps.has(id)) {
      const named = NAMED.exec(rest);
      const stage = named?.[1] ?? '';
      const keep = named && stage !== 'internal' && !stage.startsWith('auth');
      steps.set(id, keep ? { id, stage, instruction: named[2] ?? '', status: 'running', seconds: null } : null);
      continue;
    }
    const step = steps.get(id);
    if (!step) continue;
    const done = DONE.exec(rest);
    if (rest === 'CACHED') step.status = 'cached';
    else if (done) Object.assign(step, { status: 'done', seconds: Number(done[1]) });
    else if (rest.startsWith('ERROR')) step.status = 'error';
    else if (rest === 'CANCELED') step.status = 'canceled';
  }
  return [...steps.values()].filter((s): s is BuildLayer => s !== null).sort((a, b) => a.id - b.id);
}
