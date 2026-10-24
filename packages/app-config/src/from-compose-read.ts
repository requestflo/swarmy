/**
 * Reading compose shapes for {@link composeToAppConfig} — pure and
 * forgiving: an entry it can't read is skipped, never thrown.
 */
export type ComposeService = Record<string, unknown>;

/** A swarmy unit name from a compose service name, unique within `taken`. */
export function unitName(raw: string, taken: Set<string>): string {
  let n = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(n)) n = `s-${n}`;
  n = n.slice(0, 30).replace(/-+$/, '') || 'svc';
  let out = n;
  for (let i = 2; taken.has(out); i++) out = `${n.slice(0, 27)}-${i}`;
  taken.add(out);
  return out;
}

export function appName(raw: string): string {
  const n = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return /^[a-z]/.test(n) ? n : `app-${n}`.slice(0, 40);
}

/** `environment:` as a map, from either the list or the map form. */
export function envOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const i = entry.indexOf('=');
      if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v !== null && v !== undefined) out[k] = String(v);
    }
  }
  return out;
}

export interface PortEntry {
  /** As written (`8080:3000`, `3000`). */
  raw: string;
  /** The container side. */
  target: number;
  /** The host side, when it's published. */
  published?: string;
}

const isPort = (n: number): boolean => Number.isInteger(n) && n > 0 && n < 65536;

/** `ports:` / `expose:` entries: `"8080:3000"`, `"127.0.0.1:8080:3000/tcp"`, `3000`, `{ target, published }`. */
export function portsOf(raw: unknown): PortEntry[] {
  const out: PortEntry[] = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    if (typeof p === 'number') {
      if (isPort(p)) out.push({ raw: String(p), target: p });
    } else if (typeof p === 'string') {
      const parts = p.split('/')[0]!.split(':');
      const target = Number(parts.at(-1)?.split('-')[0]);
      const published = parts.length > 1 ? parts.at(-2) : undefined;
      if (isPort(target)) out.push({ raw: p, target, ...(published ? { published } : {}) });
    } else if (p && typeof p === 'object' && typeof (p as { target?: unknown }).target === 'number') {
      const { target, published } = p as { target: number; published?: unknown };
      const pub = published === undefined || published === null || published === '' ? undefined : String(published);
      if (isPort(target)) out.push({ raw: pub ? `${pub}:${target}` : String(target), target, ...(pub ? { published: pub } : {}) });
    }
  }
  return out;
}

/** The container-side port of the first `ports:` / `expose:` entry. */
export function firstPort(svc: ComposeService): number | undefined {
  return (portsOf(svc.ports)[0] ?? portsOf(svc.expose)[0])?.target;
}

export interface VolumeEntry {
  /** As written (`pgdata:/var/lib/postgresql/data`). */
  raw: string;
  /** The named volume or host path; absent for an anonymous volume. */
  source?: string;
  target: string;
  /** A host path (`./data`, `/srv/x`, `~/x`) rather than a named volume. */
  bind: boolean;
}

/** `volumes:` entries in the short (`src:target[:mode]`) or long (`{ type, source, target }`) form. */
export function volumesOf(raw: unknown): VolumeEntry[] {
  const out: VolumeEntry[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    let source: string | undefined;
    let target: string | undefined;
    let type: unknown;
    if (typeof v === 'string') {
      const parts = v.split(':');
      [source, target] = parts.length === 1 ? [undefined, parts[0]] : [parts[0], parts[1]];
    } else if (v && typeof v === 'object') {
      ({ source, target, type } = v as { source?: string; target?: string; type?: unknown });
    }
    if (!target || !target.startsWith('/')) continue;
    const raw = typeof v === 'string' ? v : `${source ?? ''}:${target}`;
    const bind = type === 'bind' || Boolean(source && /^[./~]/.test(source));
    out.push({ raw, target, bind, ...(source ? { source } : {}) });
  }
  return out;
}

export function commandOf(raw: unknown): string | string[] | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof x === 'string')) return raw as string[];
  return undefined;
}

export function relPath(p: string): string {
  const clean = p.replace(/^\.\/+/, '').replace(/\/+$/, '');
  return clean === '' || clean === '.' ? '.' : clean;
}

/** The major version in an image tag: `postgres:14-alpine` → 14, `pgvector/pgvector:pg16` → 16. */
export function imageMajor(image: string): number | undefined {
  const m = /:(?:pg)?(\d+)(?:[.-]|$)/.exec(image);
  return m ? Number(m[1]) : undefined;
}

/** `build:` or `image:` for an app service, or null when it has neither. */
export function sourceOf(svc: ComposeService): Record<string, unknown> | null {
  if (typeof svc.build === 'string') return { build: relPath(svc.build) };
  if (svc.build && typeof svc.build === 'object') {
    const b = svc.build as { context?: unknown; dockerfile?: unknown; target?: unknown; args?: unknown };
    const build: Record<string, unknown> = { path: relPath(typeof b.context === 'string' ? b.context : '.') };
    if (typeof b.dockerfile === 'string') build.dockerfile = b.dockerfile;
    if (typeof b.target === 'string') build.target = b.target;
    const args = envOf(b.args);
    if (Object.keys(args).length) build.args = args;
    return { build };
  }
  return typeof svc.image === 'string' ? { image: svc.image } : null;
}
