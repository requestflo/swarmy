/**
 * Issue grouping (pure) — a port of the shape of Sentry's default grouping
 * (newstyle): an event's hash is built from, in order of preference,
 *
 *   1. the SDK's own `fingerprint` (with `{{ default }}` expanded to 2–4);
 *   2. the exception chain's IN-APP frames (+ each exception's type);
 *   3. the exception chain's frames, in-app or not ("system" variant);
 *   4. exception type + parametrised value, when there is no stack at all;
 *   5. the parametrised message template;
 *   6. the title (last resort).
 *
 * A frame contributes `module || cleaned filename` and its function name;
 * without a usable function it contributes its context line instead. Line
 * and column numbers never contribute (a deploy that shifts code must not
 * split an issue). Filenames are cleaned of URL origins, query strings and
 * content hashes (`main.3f9a1c2e.js`) for the same reason.
 *
 * Output is the md5 of the components — 32 hex chars, like Sentry's hashes.
 * Goldens live in `grouping.test.ts`.
 */
import { createHash } from 'node:crypto';
import type { NormalizedEvent, SentryException, SentryFrame } from './event';

export type GroupingVariant =
  | 'custom'
  | 'exception-in-app'
  | 'exception-system'
  | 'exception-no-stack'
  | 'message'
  | 'fallback';

export interface Grouping {
  hash: string;
  variant: GroupingVariant;
  /** The strings hashed — kept for debugging ("why did these group?"). */
  components: string[];
}

/** Placeholders SDK fingerprints may use. */
const DEFAULT_PLACEHOLDER = /^\{\{\s*default\s*\}\}$/i;

/* ----------------------------------------------------------------------------
 * Normalisers
 * ------------------------------------------------------------------------- */

/** Content-hash-looking filename segments: `.3f9a1c2e.` / `-3f9a1c2e.` / chunk ids. */
const HASH_SEG = /([.-])[0-9a-f]{8,}(?=[.-])/gi;

export function cleanFilename(name: string): string {
  let f = name.trim();
  f = f.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // scheme + host (http://, webpack://, app://)
  f = f.replace(/^~/, '');
  f = f.replace(/[?#].*$/, '');
  f = f.replace(HASH_SEG, '$1<hash>');
  // node_modules paths group by package-relative path, not install location.
  const nm = f.lastIndexOf('/node_modules/');
  if (nm !== -1) f = f.slice(nm + 1);
  return f;
}

const ANON = new Set(['?', '<anonymous>', 'anonymous', '<unknown>', 'Anonymous function', '']);

export function cleanFunction(fn: string | null | undefined): string | null {
  if (!fn) return null;
  let f = fn.trim();
  f = f.replace(/^async\s+/, '').replace(/^new\s+/, '');
  f = f.replace(/\s*\[as [^\]]+\]$/, ''); // `foo [as bar]`
  f = f.replace(/^Object\./, '').replace(/^Module\./, '');
  f = f.replace(/<anonymous>|<unknown>/g, '?'); // V8 `Foo.<anonymous>`
  // `Server.?` / `Foo.<anonymous>`: the receiver alone doesn't identify the
  // function — fall back to the context line.
  if (f.endsWith('.?')) return null;
  if (ANON.has(f) || f.endsWith('.')) return null;
  return f;
}

/**
 * Sentry-style message parametrisation: variable bits (numbers, hex ids,
 * UUIDs, IPs, emails, ISO timestamps, quoted values) become placeholders so
 * `user 41 not found` and `user 42 not found` share an issue.
 */
export function parametrize(message: string): string {
  return message
    .slice(0, 1024)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g, '<date>')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\b\d+(\.\d+)?\b/g, '<int>');
}

/* ----------------------------------------------------------------------------
 * Components
 * ------------------------------------------------------------------------- */

/** One frame's grouping contribution, or null when it has nothing stable to say. */
export function frameComponent(f: SentryFrame): string | null {
  const where = f.module?.trim() || (f.filename || f.abs_path ? cleanFilename(f.filename || f.abs_path || '') : '');
  const fn = cleanFunction(f.function);
  if (fn) return `${where}|${fn}`;
  const ctx = f.context_line?.trim();
  if (ctx && ctx.length <= 200) return `${where}|~${ctx}`;
  return where ? `${where}|?` : null;
}

function framesOf(e: SentryException): SentryFrame[] {
  return (e.stacktrace?.frames ?? []).filter((f): f is SentryFrame => !!f && typeof f === 'object');
}

/** Collapse direct recursion (identical consecutive components) — Sentry does the same. */
function dedupeConsecutive(xs: string[]): string[] {
  return xs.filter((x, i) => i === 0 || xs[i - 1] !== x);
}

function exceptionComponents(exceptions: SentryException[], inAppOnly: boolean): string[] | null {
  const out: string[] = [];
  let anyFrames = false;
  for (const e of exceptions) {
    const synthetic = e.mechanism?.synthetic === true;
    const frames = framesOf(e).filter((f) => !inAppOnly || f.in_app === true);
    const comps = dedupeConsecutive(frames.map(frameComponent).filter((c): c is string => !!c));
    if (comps.length) anyFrames = true;
    // Type names the failure; a synthetic exception's type/value are made up by the SDK.
    if (!synthetic && e.type) out.push(`type:${e.type}`);
    out.push(...comps.map((c) => `frame:${c}`));
  }
  return anyFrames ? out : null;
}

/** The default components (what `{{ default }}` expands to) and the variant that produced them. */
export function defaultComponents(e: NormalizedEvent, messageTemplate?: string): { variant: GroupingVariant; components: string[] } {
  if (e.exceptions.length) {
    const inApp = exceptionComponents(e.exceptions, true);
    if (inApp) return { variant: 'exception-in-app', components: inApp };
    const system = exceptionComponents(e.exceptions, false);
    if (system) return { variant: 'exception-system', components: system };
    const last = e.exceptions[e.exceptions.length - 1]!;
    if (last.mechanism?.synthetic !== true && (last.type || last.value)) {
      return {
        variant: 'exception-no-stack',
        components: [`type:${last.type ?? ''}`, `value:${parametrize(last.value ?? '')}`],
      };
    }
  }
  const msg = messageTemplate ?? e.message;
  if (msg) return { variant: 'message', components: [`message:${parametrize(msg)}`] };
  return { variant: 'fallback', components: [`title:${e.title}`] };
}

function md5(parts: string[]): string {
  return createHash('md5').update(parts.join('\n')).digest('hex');
}

/** Expand SDK fingerprint placeholders against the event. */
function expandFingerprint(fp: string[], e: NormalizedEvent, def: string[]): string[] {
  const out: string[] = [];
  for (const raw of fp) {
    const p = raw.trim();
    if (DEFAULT_PLACEHOLDER.test(p)) {
      out.push(...def);
      continue;
    }
    const m = /^\{\{\s*([a-z_.]+)\s*\}\}$/i.exec(p);
    if (m) {
      const key = m[1]!.toLowerCase();
      const v =
        key === 'transaction' ? e.transaction
        : key === 'type' || key === 'error.type' ? e.excType
        : key === 'value' || key === 'error.value' ? e.excValue
        : key === 'level' ? e.level
        : key === 'message' ? e.message
        : key.startsWith('tags.') ? (e.tags[key.slice(5)] ?? '')
        : '';
      out.push(`${key}:${v}`);
      continue;
    }
    out.push(`fp:${p}`);
  }
  return out;
}

/** Group one normalised event. */
export function computeGrouping(e: NormalizedEvent, messageTemplate?: string): Grouping {
  const def = defaultComponents(e, messageTemplate);
  if (e.fingerprint && e.fingerprint.length) {
    const components = expandFingerprint(e.fingerprint, e, def.components);
    const onlyDefault = e.fingerprint.length === 1 && DEFAULT_PLACEHOLDER.test(e.fingerprint[0]!.trim());
    if (!onlyDefault) return { hash: md5(['custom', ...components]), variant: 'custom', components };
  }
  return { hash: md5([def.variant.startsWith('exception') ? 'exception' : def.variant, ...def.components]), ...def };
}
