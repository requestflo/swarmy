/**
 * Compose variable interpolation — `docker compose` / `docker stack deploy`
 * semantics, applied to the parsed compose object BEFORE translation. PURE.
 *
 * Supported (compose-spec "Interpolation"):
 *  - `$VAR`, `${VAR}`          value; unset → "" with an `unset-variable` warning
 *  - `${VAR:-default}`         default when VAR is unset OR empty
 *  - `${VAR-default}`          default when VAR is unset
 *  - `${VAR:?message}`         error when VAR is unset OR empty
 *  - `${VAR?message}`          error when VAR is unset
 *  - `${VAR:+alt}` / `${VAR+alt}`  alt when VAR is set (and non-empty for `:+`)
 *  - `$$`                      a literal `$` (how a compose file passes `$` to
 *                              the container, e.g. `sh -c 'echo $$HOME'`)
 * Defaults / messages / alts may themselves contain `${…}` (nested).
 * A `$` followed by anything else (`$1`, `$ `, a trailing `$`, an unclosed
 * `${`) is an error, as in compose.
 *
 * Only string VALUES are interpolated, at every depth; mapping keys and
 * non-string scalars are left alone.
 *
 * WHERE THE VALUES COME FROM in swarmy: the stack's variables (its `.env`,
 * entered through the bulk `.env` editor and stored with the stack's compose
 * source — see `deployFromCompose`). This is the `.env` half of what
 * `docker stack deploy` reads; the controller's own process environment is
 * NEVER consulted (it holds the controller's secrets). Secrets belong in secret
 * variables, not in stack variables: interpolated values land in the plain
 * service spec.
 */
import type { TranslationWarning } from './warnings';

export class ComposeInterpolationError extends Error {
  constructor(
    message: string,
    /** Dotted path of the offending value, e.g. `services.web.image`. */
    readonly path: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ComposeInterpolationError';
  }
}

export type ComposeVariables = Readonly<Record<string, string | undefined>>;

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

/**
 * Interpolate one string. `onUnset` is called for each variable referenced
 * with no value and no default. Throws {@link ComposeInterpolationError}.
 */
export function interpolateString(
  input: string,
  vars: ComposeVariables,
  opts: { path?: string; onUnset?: (name: string) => void } = {},
): string {
  const path = opts.path ?? '';
  const fail = (msg: string): never => {
    throw new ComposeInterpolationError(msg, path);
  };
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }
    const next = input[i + 1];
    if (next === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (next !== undefined && NAME_START.test(next)) {
      let j = i + 1;
      while (j < input.length && NAME_CHAR.test(input[j]!)) j++;
      const name = input.slice(i + 1, j);
      out += lookup(name, vars, opts.onUnset);
      i = j;
      continue;
    }
    if (next === '{') {
      const close = matchingBrace(input, i + 1);
      if (close < 0) fail(`invalid interpolation format for "${input}": unclosed "\${"`);
      out += braced(input.slice(i + 2, close), vars, { ...opts, path }, input);
      i = close + 1;
      continue;
    }
    fail(`invalid interpolation format for "${input}": "$" must be followed by a variable name, "{", or "$" (use "$$" for a literal "$")`);
  }
  return out;
}

/** Index of the `}` closing the `{` at `open`, honouring nested `${…}`. */
function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    const c = s[k];
    if (c === '$' && s[k + 1] === '$') {
      k++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  return -1;
}

function lookup(name: string, vars: ComposeVariables, onUnset?: (name: string) => void): string {
  const v = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
  if (v === undefined) {
    onUnset?.(name);
    return '';
  }
  return v;
}

function braced(
  body: string,
  vars: ComposeVariables,
  opts: { path: string; onUnset?: (name: string) => void },
  whole: string,
): string {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/.exec(body);
  if (!m) throw new ComposeInterpolationError(`invalid interpolation format for "${whole}": "\${${body}}"`, opts.path);
  const [, name, op, rest = ''] = m as unknown as [string, string, string | undefined, string | undefined];
  const has = Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined;
  const value = has ? vars[name]! : undefined;
  const nested = () => interpolateString(rest, vars, opts);
  switch (op) {
    case undefined:
      return lookup(name, vars, opts.onUnset);
    case ':-':
      return value ? value : nested();
    case '-':
      return has ? value! : nested();
    case ':?':
      if (!value) throw new ComposeInterpolationError(`required variable ${name} is missing a value: ${nested() || 'not set'}`, opts.path);
      return value;
    case '?':
      if (!has) throw new ComposeInterpolationError(`required variable ${name} is missing a value: ${nested() || 'not set'}`, opts.path);
      return value!;
    case ':+':
      return value ? nested() : '';
    case '+':
      return has ? nested() : '';
    default:
      throw new ComposeInterpolationError(`invalid interpolation format for "${whole}"`, opts.path);
  }
}

export interface InterpolateResult<T> {
  doc: T;
  warnings: TranslationWarning[];
}

/**
 * Interpolate every string value in a parsed compose document. Returns a new
 * object (the input is not mutated) plus one `unset-variable` warning per
 * variable that was referenced without a value or default — compose's
 * "variable is not set. Defaulting to a blank string."
 */
export function interpolateCompose<T>(doc: T, vars: ComposeVariables): InterpolateResult<T> {
  const unset = new Map<string, string>();
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === 'string') {
      return interpolateString(v, vars, {
        path,
        onUnset: (name) => {
          if (!unset.has(name)) unset.set(name, path);
        },
      });
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, path ? `${path}.${k}` : k);
      return out;
    }
    return v;
  };
  const out = walk(doc, '') as T;
  const warnings: TranslationWarning[] = [...unset].map(([name, path]) => ({
    level: 'warn',
    path,
    code: 'unset-variable',
    message: `The "${name}" variable is not set. Defaulting to a blank string.`,
  }));
  return { doc: out, warnings };
}

/**
 * The inverse, for compose that swarmy GENERATES from a literal source
 * (swarmy.yaml apps, templates, blueprints): every `$` in a string value
 * becomes `$$`, so the stack deploy's interpolation hands the container the
 * exact text. Without it, `printf '%s' "$BULLMQ_CONNECT"` in a template's
 * command reached the container as `printf '%s' ""` (QA-047). Keys and
 * non-strings are untouched; the input is not mutated. PURE.
 */
export function escapeInterpolation<T>(doc: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split('$').join('$$');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(doc) as T;
}
