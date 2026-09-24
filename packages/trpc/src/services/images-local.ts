/**
 * Built-in registry (`registry:2`, the `swarmy-registry` swarm service) as the
 * FIRST source for the image picker: images the cluster already has are
 * suggested before Docker Hub, and still work with no internet.
 *
 * Reachability: the controller sits on `swarmy-control`, not the `swarmy`
 * overlay the registry joins, so `swarmy-registry:5000` doesn't resolve for it.
 * The registry publishes :5000 on the swarm ROUTING MESH, so any swarm node's
 * address answers — the controller tries `SWARMY_REGISTRY_URL` (explicit
 * override), then each ready node's swarm address, then a non-loopback
 * configured host, and remembers the first that answers. Plain HTTP (the
 * registry is intra-swarm, firewalled from outside); htpasswd basic auth with
 * the org's auto-generated login.
 *
 * Best-effort like the Hub proxy: any failure yields `null` (no local section),
 * never an error.
 */
import type { SwarmNodeInfo } from '@swarmy/core/protocol';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { decodeRegistryCreds, REGISTRY_PORT, type RegistryCreds } from './registry-auth';
import { canonicalRegistryHost, DEFAULT_REGISTRY_HOST, LEGACY_REGISTRY_HOST } from './registryPolicy.service';

const FETCH_TIMEOUT_MS = 2_500;
const CATALOG_TTL_MS = 30_000;
const TAGS_TTL_MS = 30_000;

// ── pure ─────────────────────────────────────────────────────────────────────

/** Ordered base URLs to try for the registry's HTTP API. */
export function registryBaseCandidates(opts: {
  override: string | undefined;
  nodes: readonly Pick<SwarmNodeInfo, 'addr' | 'status'>[];
  registryHost: string;
}): string[] {
  const out: string[] = [];
  const add = (u: string | undefined): void => {
    if (!u) return;
    const base = u.replace(/\/+$/, '');
    if (!out.includes(base)) out.push(base);
  };
  add(opts.override);
  for (const n of opts.nodes) {
    if (n.status !== 'ready' || !n.addr || n.addr === '0.0.0.0') continue;
    const host = n.addr.includes(':') && !n.addr.startsWith('[') ? `[${n.addr}]` : n.addr;
    add(`http://${host}:${REGISTRY_PORT}`);
  }
  // A custom (non-loopback, non-legacy) host may be directly reachable.
  const h = opts.registryHost;
  if (h && h !== DEFAULT_REGISTRY_HOST && h !== LEGACY_REGISTRY_HOST && !/^(localhost|127\.)/.test(h)) {
    add(/^https?:\/\//.test(h) ? h : `https://${h}`);
  }
  return out;
}

/**
 * Catalogue repos matching the query, as pull names on the canonical host
 * (what a node pulls). Prefix matches of the last path segment rank first.
 */
export function filterCatalog(repos: readonly string[], query: string, registryHost: string, limit = 10): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = repos
    .filter((r) => r.toLowerCase().includes(q))
    .map((r) => {
      const leaf = (r.split('/').pop() ?? r).toLowerCase();
      return { r, score: leaf === q ? 0 : leaf.startsWith(q) ? 1 : 2 };
    })
    .sort((a, b) => a.score - b.score || a.r.localeCompare(b.r));
  return scored.slice(0, limit).map(({ r }) => `${registryHost}/${r}`);
}

/**
 * If the image lives in the built-in registry, its repo path (no host/tag/
 * digest); else null. Recognises the org's host plus the canonical and legacy
 * default hosts.
 */
export function localRepoOf(image: string, registryHost: string): string | null {
  const noDigest = image.split('@')[0] ?? image;
  for (const h of new Set([registryHost, DEFAULT_REGISTRY_HOST, LEGACY_REGISTRY_HOST])) {
    if (!h || !noDigest.startsWith(`${h}/`)) continue;
    const rest = noDigest.slice(h.length + 1);
    const colon = rest.lastIndexOf(':');
    const repo = colon > 0 && !rest.slice(colon + 1).includes('/') ? rest.slice(0, colon) : rest;
    return repo || null;
  }
  return null;
}

/** Newest-looking first: `latest` on top, then descending natural order. */
export function sortLocalTags(tags: readonly string[]): string[] {
  return [...tags].sort((a, b) => {
    if (a === 'latest') return -1;
    if (b === 'latest') return 1;
    return b.localeCompare(a, undefined, { numeric: true });
  });
}

// ── I/O ──────────────────────────────────────────────────────────────────────

interface LocalRegistry {
  host: string;
  creds: RegistryCreds | null;
  candidates: string[];
}

const workingBase = new Map<string, string>();
const catalogCache = new Map<string, { value: string[]; expires: number }>();
const tagsCache = new Map<string, { value: string[]; expires: number }>();

async function resolveLocalRegistry(db: DB, hub: AgentHub, orgId: string): Promise<LocalRegistry | null> {
  const row = await db.registryConfig
    .findUnique({ where: { orgId }, select: { enabled: true, host: true, credentialsEnc: true } })
    .catch(() => null);
  if (!row?.enabled) return null;
  const host = canonicalRegistryHost(row.host);
  let nodes: SwarmNodeInfo[] = [];
  try {
    nodes = hub.nodeInventory(orgId);
  } catch {
    nodes = [];
  }
  return {
    host,
    creds: decodeRegistryCreds(row.credentialsEnc),
    candidates: registryBaseCandidates({ override: process.env.SWARMY_REGISTRY_URL, nodes, registryHost: host }),
  };
}

async function getJson(url: string, creds: RegistryCreds | null): Promise<unknown | null> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (creds) headers.authorization = `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** GET a registry API path against the first base that answers (sticky per org). */
async function registryGet(orgId: string, reg: LocalRegistry, path: string): Promise<unknown | null> {
  const known = workingBase.get(orgId);
  const order = known ? [known, ...reg.candidates.filter((c) => c !== known)] : reg.candidates;
  for (const base of order) {
    const json = await getJson(`${base}${path}`, reg.creds);
    if (json !== null) {
      workingBase.set(orgId, base);
      return json;
    }
  }
  workingBase.delete(orgId);
  return null;
}

/** Local repos matching the query as pull names, or null when the registry is off/unreachable. */
export async function searchLocalImages(
  deps: { db: DB; hub: AgentHub; orgId: string },
  query: string,
): Promise<string[] | null> {
  const reg = await resolveLocalRegistry(deps.db, deps.hub, deps.orgId);
  if (!reg) return null;
  const hit = catalogCache.get(deps.orgId);
  let repos = hit && hit.expires > Date.now() ? hit.value : undefined;
  if (!repos) {
    const json = (await registryGet(deps.orgId, reg, '/v2/_catalog?n=1000')) as { repositories?: unknown } | null;
    if (!json || !Array.isArray(json.repositories)) return null;
    repos = json.repositories.filter((r): r is string => typeof r === 'string');
    catalogCache.set(deps.orgId, { value: repos, expires: Date.now() + CATALOG_TTL_MS });
  }
  return filterCatalog(repos, query, reg.host);
}

/** Tags for a built-in-registry image, or null when it isn't one / unreachable. */
export async function listLocalTags(
  deps: { db: DB; hub: AgentHub; orgId: string },
  image: string,
): Promise<string[] | null> {
  const reg = await resolveLocalRegistry(deps.db, deps.hub, deps.orgId);
  if (!reg) return null;
  const repo = localRepoOf(image, reg.host);
  if (!repo) return null;
  const key = `${deps.orgId}\u0000${repo}`;
  const hit = tagsCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const path = `/v2/${repo.split('/').map(encodeURIComponent).join('/')}/tags/list`;
  const json = (await registryGet(deps.orgId, reg, path)) as { tags?: unknown } | null;
  if (!json) return null;
  const tags = sortLocalTags(Array.isArray(json.tags) ? json.tags.filter((t): t is string => typeof t === 'string') : []);
  tagsCache.set(key, { value: tags, expires: Date.now() + TAGS_TTL_MS });
  return tags;
}
