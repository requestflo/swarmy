import { SWARMY_YAML_JSON_SCHEMA } from '@swarmy/app-config';
import type { CursorContext } from './yaml-context';

/**
 * Autocomplete candidates at the cursor, read from app-config's own JSON
 * Schema (the one a test keeps in step with the Zod parser): the keys a
 * mapping takes, a key's allowed values, and — where the schema says "a name
 * of your choosing" with typed branches (`resources:`) — one starter block
 * per type, filled with the schema's defaults. Pure.
 */
interface Node {
  type?: string | readonly string[];
  properties?: Record<string, Node>;
  additionalProperties?: Node | boolean;
  anyOf?: readonly Node[];
  enum?: readonly unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
}

export interface Completion {
  label: string;
  detail: string;
  /** Replaces the partial word (from `CursorContext.from` to the cursor). */
  insert: string;
  kind: 'key' | 'value' | 'starter';
}
export interface CompletionList {
  /** The schema location, e.g. `resources.<name>.type`. */
  title: string;
  items: Completion[];
}

const ROOT = SWARMY_YAML_JSON_SCHEMA as unknown as Node;
const flat = (n: Node): Node[] => (n.anyOf ? n.anyOf.flatMap(flat) : [n]);
const isMap = (n: Node): boolean => Boolean(n.properties) || typeof n.additionalProperties === 'object';
const maps = (n: Node): Node[] => flat(n).filter(isMap);
const child = (n: Node, key: string): Node | undefined =>
  n.properties?.[key] ?? (typeof n.additionalProperties === 'object' ? n.additionalProperties : undefined);

/** The mapping schema(s) at `path` and its label (`services.<name>`). */
export function mappingAt(path: readonly string[]): { nodes: Node[]; label: string } {
  let nodes = maps(ROOT);
  const label: string[] = [];
  for (const seg of path) {
    label.push(nodes.some((n) => n.properties?.[seg]) ? seg : '<name>');
    nodes = nodes.flatMap((n) => {
      const c = child(n, seg);
      return c ? maps(c) : [];
    });
    if (!nodes.length) break;
  }
  return { nodes, label: label.join('.') };
}

/** Typed branches (`type: postgres`) narrowed by the mapping's own `type:`. */
function narrow(nodes: Node[], siblings: Record<string, string>): Node[] {
  const t = siblings['type'];
  const hit = t ? nodes.filter((n) => n.properties?.['type']?.const === t) : [];
  return hit.length ? hit : nodes;
}

const scalar = (v: unknown): string | null =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;

function valuesOf(n: Node): string[] {
  const own = [...(n.enum ?? []), ...(n.const !== undefined ? [n.const] : [])].map(scalar).filter((v): v is string => v !== null);
  const bool = n.type === 'boolean' ? ['true', 'false'] : [];
  return [...own, ...bool, ...(n.anyOf ?? []).flatMap(valuesOf)];
}

function describe(n: Node): string {
  if (n.description) return n.description;
  const vals = valuesOf(n);
  if (vals.length) return vals.join(' | ');
  return Array.isArray(n.type) ? n.type.join(' | ') : (n.type as string | undefined) ?? (isMap(n) ? 'a block' : '');
}

/** Name a starter block after its type, without colliding with what's there. */
const STARTER_NAME: Record<string, string> = { postgres: 'db', vector: 'embeddings', bucket: 'uploads' };
function freeName(base: string, taken: Record<string, string>): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!(name in taken)) return name;
  }
}

function starters(nodes: Node[], ctx: CursorContext): Completion[] {
  const pad = ' '.repeat(ctx.indent + 2);
  const typed = nodes.flatMap((n) => (typeof n.additionalProperties === 'object' ? maps(n.additionalProperties) : []));
  return typed.flatMap((b): Completion[] => {
    const t = scalar(b.properties?.['type']?.const);
    if (!t) return [];
    const defaults = Object.entries(b.properties ?? {}).flatMap(([k, p]) => {
      const v = k === 'type' ? null : scalar(p.default);
      return v === null ? [] : [`${k}: ${v}`];
    });
    const name = freeName(STARTER_NAME[t] ?? t, ctx.siblings);
    return [{
      label: t,
      detail: b.description ?? (defaults.length ? defaults.join(' · ') : `a ${t}`),
      insert: [`${name}:`, ...[`type: ${t}`, ...defaults].map((l) => pad + l)].join('\n'),
      kind: 'starter',
    }];
  });
}

const matches = (label: string, prefix: string): boolean => label.toLowerCase().startsWith(prefix.toLowerCase());

/** Candidates for the cursor, or null when the schema has none there. */
export function completionsFor(ctx: CursorContext): CompletionList | null {
  if (ctx.kind === 'none') return null;
  const { nodes: all, label } = mappingAt(ctx.path);
  if (!all.length) return null;
  const nodes = narrow(all, ctx.siblings);
  if (ctx.kind === 'value') {
    const key = ctx.key ?? '';
    const props = nodes.map((n) => child(n, key)).filter((p): p is Node => Boolean(p));
    const items = [...new Set(props.flatMap(valuesOf))]
      .filter((v) => matches(v, ctx.prefix))
      .map((v): Completion => ({ label: v, detail: props[0]?.description ?? '', insert: v, kind: 'value' }));
    const title = `${label ? `${label}.` : ''}${nodes.some((n) => n.properties?.[key]) ? key : '<name>'}`;
    return items.length && !(items.length === 1 && items[0]?.label === ctx.prefix) ? { title, items } : null;
  }
  const keys = new Map<string, Node>();
  for (const n of nodes) for (const [k, p] of Object.entries(n.properties ?? {})) if (!keys.has(k)) keys.set(k, p);
  if (!keys.size) {
    const items = starters(nodes, ctx).filter((c) => matches(c.label, ctx.prefix));
    return items.length ? { title: `${label}.<name>.type`, items } : null;
  }
  const pad = ' '.repeat(ctx.indent + 2);
  const items = [...keys]
    .filter(([k]) => !(k in ctx.siblings) && matches(k, ctx.prefix))
    .map(([k, p]): Completion => ({
      label: k,
      detail: describe(p),
      insert: flat(p).every(isMap) ? `${k}:\n${pad}` : `${k}: `,
      kind: 'key',
    }));
  return items.length ? { title: label || 'swarmy.yaml', items } : null;
}
