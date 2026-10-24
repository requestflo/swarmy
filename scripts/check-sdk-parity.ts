#!/usr/bin/env bun
/**
 * Fail when a REST route in the committed spec (`packages/api-rest/openapi.json`)
 * has no hand-written method in one of the SDKs, or when an SDK calls a route
 * the spec does not have.
 *
 *   bun run scripts/check-sdk-parity.ts            # check; prints the gaps
 *   bun run scripts/check-sdk-parity.ts --table    # also print route × SDK
 *
 * The models are generated, but every route's method is written by hand
 * (`scripts/gen-sdks.ts` never touches the resource layers), so a new route
 * ships without an SDK method unless something says so. This is that thing.
 *
 * A method is found by its call site in the SDK's hand-written sources: the
 * transport call with an HTTP method literal and an inline path —
 *   Go          s.client.do(ctx, "GET", "/services/"+pathEscape(id), …)   (also doRaw, stream)
 *   TypeScript  this.http.request<T>('GET', `/services/${encodeURIComponent(id)}`, …)   (also raw)
 *   Python      self._http.request("GET", "/services/{}".format(_quote(service_id)), …)   (also request_raw, stream)
 * so the path must be written inline, never through a variable.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Sdk = 'go' | 'python' | 'typescript';
export const SDKS: Sdk[] = ['go', 'python', 'typescript'];

/**
 * Routes an SDK leaves out on purpose, keyed `METHOD /path` as the spec
 * writes it. Every entry says why; an entry whose route the SDK now has, or
 * the spec no longer has, fails the check so the list cannot rot.
 */
export const ALLOWLIST: Record<string, { sdks: Sdk[]; reason: string }> = {
  'POST /nodes/{id}/cordon': {
    sdks: ['go', 'python', 'typescript'],
    reason: 'an alias of POST /nodes/{id}/drain; the SDKs expose drain and uncordon',
  },
};

const SOURCES: Record<Sdk, { dir: string; ext: string; generated: string }> = {
  go: { dir: 'sdks/go', ext: '.go', generated: 'models.go' },
  python: { dir: 'sdks/python/swarmy', ext: '.py', generated: 'models.py' },
  typescript: { dir: 'sdks/typescript/src', ext: '.ts', generated: 'models.ts' },
};

/** The transport calls a route goes through, in any SDK. */
const CALLEES = new Set(['do', 'doRaw', 'stream', 'request', 'request_raw', 'raw']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** `/services/{id}/scale` → `/services/{}/scale`: path params compare by position, not name. */
export function normalizePath(path: string): string {
  return path.replace(/\{[^}]*\}/g, '{}');
}

/**
 * Read one string literal starting at `src[i]` (a quote). Returns its content
 * — a template literal's `${…}` parts become `{}` — and the index after it.
 */
function readString(src: string, i: number): { text: string; end: number } {
  const quote = src[i]!;
  let text = '';
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === '\\') {
      text += src[j + 1] ?? '';
      j += 2;
    } else if (quote === '`' && src[j] === '$' && src[j + 1] === '{') {
      j = skipBalanced(src, j + 1);
      text += '{}';
    } else {
      text += src[j];
      j += 1;
    }
  }
  return { text, end: j + 1 };
}

/** From an opening bracket at `src[i]`, the index after its matching close (strings respected). */
function skipBalanced(src: string, i: number): number {
  const open = src[i]!;
  const close = ({ '(': ')', '[': ']', '{': '}', '<': '>' } as Record<string, string>)[open]!;
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      j = readString(src, j).end;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close && !(open === '<' && src[j - 1] === '=')) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return j;
}

/**
 * One call argument starting at `i`, up to the next top-level `,` or `)`,
 * as a path template: string literals contribute their text, anything else
 * (`pathEscape(id)`, a `+`) is a path parameter `{}`.
 */
function readPathArg(src: string, i: number): string | undefined {
  let path = '';
  let j = i;
  let sawLiteral = false;
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === ',' || ch === ')') break;
    if (/\s|\+/.test(ch)) {
      j += 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const s = readString(src, j);
      path += s.text;
      sawLiteral = true;
      j = s.end;
      // Python: "/x/{}".format(...) — the literal already says where params go.
      if (src.startsWith('.format', j)) j = skipBalanced(src, j + '.format'.length);
    } else {
      // An expression term: an identifier or call such as pathEscape(id).
      while (j < src.length && /[\w.]/.test(src[j]!)) j += 1;
      if (src[j] === '(' || src[j] === '[') j = skipBalanced(src, j);
      else if (!/[\s+,)]/.test(src[j] ?? '')) return undefined;
      path += '{}';
    }
  }
  return sawLiteral && path.startsWith('/') ? normalizePath(path) : undefined;
}

/** Every `METHOD /path` an SDK source calls, e.g. `GET /services/{}`. */
export function extractRoutes(src: string): string[] {
  const out: string[] = [];
  const callee = /\b([A-Za-z_]\w*)\s*(?=[<(])/g;
  for (let m = callee.exec(src); m; m = callee.exec(src)) {
    if (!CALLEES.has(m[1]!)) continue;
    let j = callee.lastIndex;
    if (src[j] === '<') j = skipBalanced(src, j); // TS generic: request<T>(
    if (src[j] !== '(') continue;
    j += 1;
    const rest = src.slice(j);
    const head = /^\s*(?:ctx\s*,\s*)?(["'])([A-Z]+)\1\s*,\s*/.exec(rest);
    if (!head || !METHODS.has(head[2]!)) continue;
    const path = readPathArg(src, j + head[0].length);
    if (path) out.push(`${head[2]} ${path}`);
  }
  return out;
}

/** The spec's routes as `METHOD /path` (as written) keyed by their normalized form. */
export function specRoutes(spec: {
  paths: Record<string, Record<string, unknown>>;
}): Map<string, string> {
  const routes = new Map<string, string>();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) {
      const m = method.toUpperCase();
      if (METHODS.has(m)) routes.set(`${m} ${normalizePath(path)}`, `${m} ${path}`);
    }
  }
  return routes;
}

export interface ParityReport {
  /** Per SDK, the spec routes (as written) it has no method for and does not allowlist. */
  missing: Record<Sdk, string[]>;
  /** Per SDK, calls to a `METHOD /path` the spec does not have. */
  unknown: Record<Sdk, string[]>;
  /** Allowlist entries that no longer hold (the SDK has the route, or the spec lost it). */
  stale: string[];
  /** Per spec route (as written), the SDKs that call it. */
  coverage: Map<string, Set<Sdk>>;
}

export function checkParity(
  spec: { paths: Record<string, Record<string, unknown>> },
  calls: Record<Sdk, string[]>,
  allowlist: typeof ALLOWLIST = ALLOWLIST,
): ParityReport {
  const routes = specRoutes(spec);
  const coverage = new Map<string, Set<Sdk>>([...routes.values()].map((r) => [r, new Set<Sdk>()]));
  const report: ParityReport = {
    missing: { go: [], python: [], typescript: [] },
    unknown: { go: [], python: [], typescript: [] },
    stale: [],
    coverage,
  };
  for (const sdk of SDKS) {
    for (const call of new Set(calls[sdk])) {
      const route = routes.get(call);
      if (route) coverage.get(route)!.add(sdk);
      else report.unknown[sdk].push(call);
    }
  }
  for (const [route, sdks] of coverage) {
    for (const sdk of SDKS) {
      if (!sdks.has(sdk) && !allowlist[route]?.sdks.includes(sdk)) report.missing[sdk].push(route);
    }
  }
  for (const [route, entry] of Object.entries(allowlist)) {
    const sdks = coverage.get(route);
    if (!sdks) report.stale.push(`${route}: not in the spec any more`);
    else
      for (const sdk of entry.sdks)
        if (sdks.has(sdk)) report.stale.push(`${route}: ${sdk} has a method for it now`);
  }
  return report;
}

function readSdkCalls(repoRoot: string): Record<Sdk, string[]> {
  const calls = { go: [], python: [], typescript: [] } as Record<Sdk, string[]>;
  for (const sdk of SDKS) {
    const { dir, ext, generated } = SOURCES[sdk];
    for (const file of readdirSync(join(repoRoot, dir))) {
      if (!file.endsWith(ext) || file === generated || file.endsWith('_test.go')) continue;
      calls[sdk].push(...extractRoutes(readFileSync(join(repoRoot, dir, file), 'utf-8')));
    }
  }
  return calls;
}

if (import.meta.main) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const spec = JSON.parse(readFileSync(join(repoRoot, 'packages/api-rest/openapi.json'), 'utf-8'));
  const report = checkParity(spec, readSdkCalls(repoRoot));

  if (process.argv.includes('--table')) {
    const mark = (route: string, sdk: Sdk) =>
      report.coverage.get(route)!.has(sdk)
        ? 'yes'
        : ALLOWLIST[route]?.sdks.includes(sdk)
          ? 'allowed'
          : 'MISSING';
    console.log(['route', ...SDKS].join('\t'));
    for (const route of report.coverage.keys())
      console.log([route, ...SDKS.map((s) => mark(route, s))].join('\t'));
    console.log('');
  }

  const problems: string[] = [];
  for (const sdk of SDKS) {
    for (const r of report.missing[sdk]) problems.push(`${sdk}: no method for ${r}`);
    for (const r of report.unknown[sdk])
      problems.push(`${sdk}: calls ${r}, which the spec does not have`);
  }
  for (const s of report.stale) problems.push(`allowlist: ${s}`);

  const total = report.coverage.size;
  if (problems.length) {
    console.error(`SDK parity: ${problems.length} problem(s) across ${total} routes\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      '\nAdd the method to the SDK (path written inline in the transport call), or, if the route is' +
        '\nleft out on purpose, add it to ALLOWLIST in scripts/check-sdk-parity.ts with the reason.',
    );
    process.exit(1);
  }
  const allowed = Object.entries(ALLOWLIST).map(
    ([r, e]) => `${r} (${e.sdks.join(', ')}: ${e.reason})`,
  );
  console.log(`SDK parity: all ${total} routes have a method in ${SDKS.join(', ')}.`);
  for (const a of allowed) console.log(`  allowlisted: ${a}`);
}
