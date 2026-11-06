/**
 * Terraform for the Code depth, in the provider's own words. Honesty rule
 * (code.ts): every resource and attribute must exist in
 * terraform-provider-swarmy (internal/provider/resource_*.go) —
 * code-honesty.test.ts checks the ones the pages print.
 */

/** An expression written as-is (a reference or a function call), never quoted. */
export interface HclRaw {
  raw: string;
}

export type Hcl = string | number | boolean | null | HclRaw | Hcl[] | { [k: string]: Hcl | undefined };

export const tfRef = (raw: string): HclRaw => ({ raw });

function isRaw(v: Hcl): v is HclRaw {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { raw?: unknown }).raw === 'string' && Object.keys(v).length === 1;
}

/** A quoted HCL string: `${` and `%{` would start a template, so they're escaped. */
function str(s: string): string {
  // A function replacement: in a replacement string `$$` would mean one `$`.
  return JSON.stringify(s)
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{');
}

function key(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : str(k);
}

/** One HCL value. Short objects stay on one line, as `{ n = 2 }`. */
export function hcl(v: Hcl, indent = 0): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return str(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isRaw(v)) return v.raw;
  if (Array.isArray(v)) return `[${v.map((x) => hcl(x, indent)).join(', ')}]`;
  const entries = Object.entries(v).filter((e): e is [string, Hcl] => e[1] !== undefined);
  if (entries.length === 0) return '{}';
  const inline = entries.map(([k, x]) => `${key(k)} = ${hcl(x, indent)}`).join(', ');
  if (inline.length <= 64 && !inline.includes('\n')) return `{ ${inline} }`;
  return `{\n${attrLines(entries, indent + 1)}\n${'  '.repeat(indent)}}`;
}

/** Attribute lines with their `=` aligned, as `terraform fmt` writes them. */
function attrLines(entries: [string, Hcl][], indent: number): string {
  const pad = '  '.repeat(indent);
  const width = Math.max(...entries.map(([k]) => key(k).length));
  return entries.map(([k, x]) => `${pad}${key(k).padEnd(width)} = ${hcl(x, indent)}`).join('\n');
}

/** `resource "<type>" "<name>" { … }` — attributes left undefined are left out. */
export function tfResource(type: string, name: string, attrs: Record<string, Hcl | undefined>): string {
  const entries = Object.entries(attrs).filter((e): e is [string, Hcl] => e[1] !== undefined);
  return `resource "${type}" "${name}" {\n${attrLines(entries, 1)}\n}`;
}

/** A sensitive string variable, for a write-only destination or token. */
export function tfVariable(name: string): string {
  return `variable "${name}" {\n  type      = string\n  sensitive = true\n}`;
}

/** A Terraform name from a display name: lower snake case, never starting with a digit. */
export function tfName(name: string, fallback = 'this'): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return fallback;
  return /^[0-9]/.test(s) ? `r_${s}` : s;
}

/** Names for a list of things, made unique (`ops`, `ops_2`) in the order given. */
export function tfNames(names: string[], fallback = 'this'): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const base = tfName(n, fallback);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}
