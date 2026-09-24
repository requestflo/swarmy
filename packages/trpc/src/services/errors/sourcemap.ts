/**
 * Source-map resolution (pure; Source Map v3 incl. index maps). No dependency:
 * a VLQ decoder, a per-line segment table, and a binary search.
 *
 * Also the artifact matching rules the ingest path and `swarmy sourcemaps
 * upload` agree on:
 *   - an artifact is named like Sentry's release files: `~/static/js/app.js`
 *     (`~` = any origin / any path prefix), or a full URL / absolute path;
 *   - a frame matches the artifact whose name is the longest path-SUFFIX of
 *     the frame's filename (so `/app/dist/app.js` and
 *     `https://x.com/dist/app.js` both match `~/dist/app.js`);
 *   - the map is found via the SDK's debug id (`debug_meta.images`) first,
 *     then the minified file's `sourceMappingURL`, then `<file>.map`.
 */
import type { SentryFrame } from './event';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i += 1) B64_INDEX[B64.charCodeAt(i)] = i;

/** [generatedColumn, sourceIndex, originalLine, originalColumn, nameIndex?] — all 0-based. */
type Segment = [number, number, number, number, number | undefined];

export interface ParsedSourceMap {
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  /** lines[generatedLine0] = segments sorted by generated column. */
  lines: Segment[][];
}

interface RawMap {
  version?: number;
  sources?: (string | null)[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings?: string;
  sourceRoot?: string;
  sections?: { offset: { line: number; column: number }; map: RawMap }[];
}

export class SourceMapError extends Error {}

/** Decode a `mappings` string into per-line absolute segments (appended to `into`). */
function decodeMappings(
  mappings: string,
  lineOffset: number,
  colOffset: number,
  srcOffset: number,
  nameOffset: number,
  into: Segment[][],
): void {
  let line = lineOffset;
  let genCol = 0;
  let src = 0;
  let origLine = 0;
  let origCol = 0;
  let name = 0;
  const values: number[] = [];
  const row = (l: number): Segment[] => into[l] ?? (into[l] = []);

  const flush = () => {
    if (!values.length) return;
    genCol += values[0]!;
    if (values.length >= 4) {
      src += values[1]!;
      origLine += values[2]!;
      origCol += values[3]!;
      if (values.length >= 5) name += values[4]!;
      // An index-map section's column offset applies to its first line only.
      const col = line === lineOffset ? genCol + colOffset : genCol;
      row(line).push([col, src + srcOffset, origLine, origCol, values.length >= 5 ? name + nameOffset : undefined]);
    }
    values.length = 0;
  };

  const n = mappings.length;
  let i = 0;
  while (i < n) {
    const ch = mappings.charCodeAt(i);
    if (ch === 59 /* ; */) {
      flush();
      line += 1;
      genCol = 0;
      i += 1;
      continue;
    }
    if (ch === 44 /* , */) {
      flush();
      i += 1;
      continue;
    }
    let result = 0;
    let shift = 0;
    let cont = true;
    while (cont) {
      if (i >= n) throw new SourceMapError('truncated VLQ');
      const code = mappings.charCodeAt(i);
      const d = code < 128 ? B64_INDEX[code]! : -1;
      if (d === -1) throw new SourceMapError(`invalid base64 in mappings at ${i}`);
      i += 1;
      cont = (d & 32) !== 0;
      result += (d & 31) * 2 ** shift;
      shift += 5;
    }
    values.push(result % 2 === 1 ? -Math.floor(result / 2) : Math.floor(result / 2));
  }
  flush();
}

function joinRoot(root: string | undefined, s: string): string {
  if (!root) return s;
  return root.endsWith('/') ? root + s : `${root}/${s}`;
}

/** Parse a source map (JSON string or object). Throws {@link SourceMapError}. */
export function parseSourceMap(input: string | RawMap): ParsedSourceMap {
  let raw: RawMap;
  try {
    raw = typeof input === 'string' ? (JSON.parse(input.replace(/^\)\]\}'[^\n]*\n/, '')) as RawMap) : input;
  } catch {
    throw new SourceMapError('source map is not JSON');
  }
  const out: ParsedSourceMap = { sources: [], sourcesContent: [], names: [], lines: [] };
  const add = (m: RawMap, lineOff: number, colOff: number) => {
    if (m.sections) {
      for (const s of m.sections) add(s.map, lineOff + s.offset.line, (s.offset.line === 0 ? colOff : 0) + s.offset.column);
      return;
    }
    if (typeof m.mappings !== 'string') throw new SourceMapError('source map has no mappings');
    const srcOff = out.sources.length;
    const nameOff = out.names.length;
    for (const [i, s] of (m.sources ?? []).entries()) {
      out.sources.push(joinRoot(m.sourceRoot, s ?? ''));
      out.sourcesContent.push(m.sourcesContent?.[i] ?? null);
    }
    out.names.push(...(m.names ?? []));
    decodeMappings(m.mappings, lineOff, colOff, srcOff, nameOff, out.lines);
  };
  add(raw, 0, 0);
  for (const segs of out.lines) segs?.sort((a, b) => a[0] - b[0]);
  return out;
}

export interface OriginalPosition {
  source: string;
  /** 1-based, like Sentry frames. */
  line: number;
  /** 1-based. */
  column: number;
  name: string | null;
}

/** Map a generated (1-based line, 1-based column) position to the original. */
export function originalPositionFor(map: ParsedSourceMap, line: number, column: number): OriginalPosition | null {
  const segs = map.lines[line - 1];
  if (!segs || !segs.length) return null;
  const col = Math.max(0, column - 1);
  let lo = 0;
  let hi = segs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]![0] <= col) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best === -1) return null;
  const s = segs[best]!;
  return {
    source: map.sources[s[1]] ?? '',
    line: s[2] + 1,
    column: s[3] + 1,
    name: s[4] !== undefined ? (map.names[s[4]] ?? null) : null,
  };
}

/* ----------------------------------------------------------------------------
 * Enclosing function name from original source
 * ------------------------------------------------------------------------- */

const FN_PATTERNS: RegExp[] = [
  /(?:^|[\s;{(])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /(?:^|[\s;{,])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /(?:^|[\s;{,])([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/,
  /^\s*(?:(?:public|private|protected|static|async|get|set|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
];
const NOT_FN = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'with']);

/**
 * The name of the function enclosing (1-based) `line` — scans upward for a
 * declaration whose body is still open. Minifiers drop `names` often (Bun
 * does), and the mapped `name` at a call site is the callee, not the frame's
 * own function, so this is how minified `n` becomes `priceOf`.
 */
export function enclosingFunctionName(source: string, line: number): string | null {
  const lines = source.split('\n');
  let depth = 0;
  for (let i = Math.min(line, lines.length) - 1; i >= 0 && i >= line - 200; i -= 1) {
    const text = lines[i] ?? '';
    // Braces on the lines BELOW the declaration tell us whether it's still open.
    if (i < line - 1) {
      for (let c = text.length - 1; c >= 0; c -= 1) {
        const ch = text[c];
        if (ch === '}') depth += 1;
        else if (ch === '{') depth -= 1;
      }
    } else {
      // The crash line itself: only braces BEFORE the statement count, which we can't
      // know precisely — ignore them.
    }
    if (depth > 0) continue;
    for (const re of FN_PATTERNS) {
      const m = re.exec(text);
      if (m && m[1] && !NOT_FN.has(m[1])) return m[1];
    }
  }
  return null;
}

/** 5 lines of context either side, like Sentry's ContextLines. */
export function contextFor(source: string, line: number, radius = 5): Pick<SentryFrame, 'pre_context' | 'context_line' | 'post_context'> {
  const lines = source.split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return {};
  const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
  return {
    pre_context: lines.slice(Math.max(0, idx - radius), idx).map(clip),
    context_line: clip(lines[idx] ?? ''),
    post_context: lines.slice(idx + 1, idx + 1 + radius).map(clip),
  };
}

/* ----------------------------------------------------------------------------
 * Artifact matching
 * ------------------------------------------------------------------------- */

/** `https://x.com/a/b.js?v=1` / `~/a/b.js` / `/srv/app/a/b.js` → `/a/b.js`-style path. */
export function artifactPath(name: string): string {
  let p = name.trim();
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  p = p.replace(/^~/, '');
  p = p.replace(/[?#].*$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/{2,}/g, '/');
}

/** The artifact name that is the longest path suffix of `filename`, or null. */
export function matchArtifact(filename: string, names: readonly string[]): string | null {
  const path = artifactPath(filename);
  let best: string | null = null;
  let bestLen = -1;
  for (const n of names) {
    const a = artifactPath(n);
    const exact = path === a;
    const suffix = path.endsWith(a) && (a.startsWith('/') || path[path.length - a.length - 1] === '/');
    if ((exact || suffix) && a.length > bestLen) {
      best = n;
      bestLen = a.length;
    }
  }
  return best;
}

/** The `sourceMappingURL` of a minified file (last one wins), or null. */
export function sourceMappingUrl(code: string): string | null {
  const re = /(?:\/\/|\/\*)[#@]\s*sourceMappingURL=([^\s*]+)/g;
  let last: string | null = null;
  for (const m of code.matchAll(re)) last = m[1] ?? null;
  return last;
}

/** Resolve a (relative) map URL against the minified artifact's name. */
export function resolveMapName(minifiedName: string, mapUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(mapUrl) || mapUrl.startsWith('/') || mapUrl.startsWith('~')) return mapUrl;
  const base = minifiedName.replace(/[?#].*$/, '');
  const dir = base.slice(0, base.lastIndexOf('/') + 1);
  const parts = (dir + mapUrl).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return out.join('/');
}

/* ----------------------------------------------------------------------------
 * Frame symbolication
 * ------------------------------------------------------------------------- */

/** Symbolicate one frame against a parsed map. Returns a NEW frame (original kept in `data.minified`). */
export function symbolicateFrame(frame: SentryFrame, map: ParsedSourceMap, mapName: string): SentryFrame {
  if (!frame.lineno || !frame.colno) return frame;
  const pos = originalPositionFor(map, frame.lineno, frame.colno);
  if (!pos) return frame;
  const srcIndex = map.sources.indexOf(pos.source);
  const content = srcIndex >= 0 ? map.sourcesContent[srcIndex] : null;
  const fn = (content ? enclosingFunctionName(content, pos.line) : null) ?? frame.function ?? null;
  const source = pos.source.replace(/^webpack:\/\/\/?(?:[^/]*\/)?/, '').replace(/^(\.\.\/)+/, '');
  return {
    ...frame,
    filename: source,
    abs_path: pos.source,
    module: null,
    function: fn,
    lineno: pos.line,
    colno: pos.column,
    ...(content ? contextFor(content, pos.line) : { pre_context: null, context_line: null, post_context: null }),
    // A mapped frame from node_modules / webpack runtime is still not the app's.
    in_app: frame.in_app !== false && !/(^|\/)node_modules\//.test(pos.source) && !/webpack\/(bootstrap|runtime)/.test(pos.source),
    data: {
      ...(frame.data ?? {}),
      sourcemap: mapName,
      symbolicated: true,
      minified: { filename: frame.filename ?? null, function: frame.function ?? null, lineno: frame.lineno ?? null, colno: frame.colno ?? null },
    },
  };
}

/** Sentry debug ids are UUIDs; Bun emits 32 bare hex chars. Store the dashed lowercase UUID form. */
export function normalizeDebugId(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

