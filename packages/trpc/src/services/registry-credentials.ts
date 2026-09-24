/**
 * Third-party registry credentials: PURE core (no DB, no hub).
 *
 * An org stores `host[/path]` + username + token (GHCR, Docker Hub, GitLab,
 * ECR/GCR/ACR, any registry). Every image a dispatch pulls is matched to the
 * LONGEST stored prefix (`ghcr.io/acme` beats `ghcr.io`), and the hub dispatch
 * decorator (`registry-auth.ts`) attaches the resolved `RegistryAuth` — the
 * `--with-registry-auth` equivalent — so every node can pull. Builds get ALL
 * org creds as `pullAuths` (private `FROM` bases).
 *
 * `testRegistryLogin` is the "test credentials" check: the registry v2 auth
 * handshake (Bearer token dance or Basic) and, when an image is given, a
 * manifest HEAD — with an injected `fetch` so it is unit-testable.
 */
import type { RegistryAuth } from '@swarmy/core/protocol';

export const DOCKER_HUB = 'docker.io';
/** The server address Docker's own config/X-Registry-Auth uses for Hub. */
export const DOCKER_HUB_SERVER = 'https://index.docker.io/v1/';
/** Hub's registry API lives on a different host than its image names. */
export const DOCKER_HUB_API = 'registry-1.docker.io';
const HUB_ALIASES = new Set([DOCKER_HUB, 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com', 'hub.docker.com']);

export const REGISTRY_PROVIDERS = ['ghcr', 'dockerhub', 'gitlab', 'ecr', 'gcr', 'acr', 'generic'] as const;
export type RegistryProvider = (typeof REGISTRY_PROVIDERS)[number];

/** A stored credential with its secret already decrypted (controller-only). */
export interface ResolvedCredential {
  prefix: string;
  username: string;
  secret: string;
}

/** Does this first path segment name a registry host (vs a Hub namespace)? */
function isHostSegment(seg: string): boolean {
  return seg.includes('.') || seg.includes(':') || seg === 'localhost';
}

/**
 * Normalise an operator-entered prefix: drop scheme + trailing slashes, lowercase
 * the host, fold Docker Hub aliases to `docker.io`. Returns null when it cannot
 * name a registry (e.g. empty, whitespace, a bare word that isn't a host).
 */
export function normalizeRegistryPrefix(input: string): string | null {
  let s = input.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  if (!s || /\s/.test(s)) return null;
  // `index.docker.io/v1` (docker config style) → the Hub itself.
  s = s.replace(/^index\.docker\.io\/v1$/i, DOCKER_HUB);
  const [rawHost = '', ...rest] = s.split('/');
  let host = rawHost.toLowerCase();
  if (!isHostSegment(host)) return null;
  if (HUB_ALIASES.has(host)) host = DOCKER_HUB;
  if (rest.some((p) => !p || !/^[a-z0-9._-]+$/.test(p))) return null;
  return [host, ...rest].join('/');
}

/**
 * Split an image ref into its registry host + repository path, tag/digest
 * dropped. Docker Hub shorthands resolve like `docker pull` does:
 * `nginx` → `docker.io/library/nginx`, `me/app:1` → `docker.io/me/app`.
 */
export function parseImageRef(image: string): { host: string; repo: string; reference: string } {
  let ref = image.trim();
  let reference = 'latest';
  const at = ref.indexOf('@');
  if (at >= 0) {
    reference = ref.slice(at + 1);
    ref = ref.slice(0, at);
  }
  const parts = ref.split('/');
  let host = DOCKER_HUB;
  if (parts.length > 1 && isHostSegment(parts[0] ?? '')) host = (parts.shift() ?? '').toLowerCase();
  if (HUB_ALIASES.has(host)) host = DOCKER_HUB;
  let last = parts.pop() ?? '';
  const colon = last.lastIndexOf(':');
  if (colon > 0) {
    if (at < 0) reference = last.slice(colon + 1);
    last = last.slice(0, colon);
  }
  parts.push(last);
  if (host === DOCKER_HUB && parts.length === 1) parts.unshift('library');
  return { host, repo: parts.join('/'), reference };
}

/** Longest stored prefix covering the image, or null. Exact path-segment match only. */
export function matchCredential<C extends { prefix: string }>(image: string, creds: readonly C[]): C | null {
  const { host, repo } = parseImageRef(image);
  const full = `${host}/${repo}`;
  let best: C | null = null;
  for (const c of creds) {
    if (full === c.prefix || full.startsWith(`${c.prefix}/`)) {
      if (!best || c.prefix.length > best.prefix.length) best = c;
    }
  }
  return best;
}

/** The `serveraddress` Docker expects for a registry host. */
export function registryServerAddress(prefix: string): string {
  const host = prefix.split('/')[0] ?? prefix;
  return host === DOCKER_HUB ? DOCKER_HUB_SERVER : host;
}

export function toRegistryAuth(c: ResolvedCredential): RegistryAuth {
  return { username: c.username, password: c.secret, server: registryServerAddress(c.prefix) };
}

/**
 * All creds as build `pullAuths`, one per registry SERVER (Docker's config.json
 * `auths` is keyed by host, so a path-scoped prefix can't coexist with another
 * for the same host — the shortest (broadest) prefix wins for builds).
 */
export function buildPullAuths(creds: readonly ResolvedCredential[]): RegistryAuth[] {
  const byServer = new Map<string, ResolvedCredential>();
  for (const c of [...creds].sort((a, b) => a.prefix.length - b.prefix.length)) {
    const server = registryServerAddress(c.prefix);
    if (!byServer.has(server)) byServer.set(server, c);
  }
  return [...byServer.values()].map(toRegistryAuth);
}

/** Host-derived provider guess for the UI (never trusted for behaviour). */
export function guessProvider(prefix: string): RegistryProvider {
  const host = prefix.split('/')[0] ?? '';
  if (host === 'ghcr.io') return 'ghcr';
  if (host === DOCKER_HUB) return 'dockerhub';
  if (host.includes('gitlab')) return 'gitlab';
  if (host.endsWith('.amazonaws.com')) return 'ecr';
  if (host === 'gcr.io' || host.endsWith('.gcr.io') || host.endsWith('-docker.pkg.dev')) return 'gcr';
  if (host.endsWith('.azurecr.io')) return 'acr';
  return 'generic';
}

// ── "Test credentials" — the registry v2 auth handshake ─────────────────────

export type RegistryTestStatus = 'ok' | 'unauthorized' | 'not_found' | 'unreachable' | 'error';

export interface RegistryTestResult {
  ok: boolean;
  status: RegistryTestStatus;
  message: string;
  /** Whether a manifest HEAD was performed (an image was given). */
  checkedManifest: boolean;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Parse `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`. */
export function parseAuthChallenge(header: string | null): { scheme: string; params: Record<string, string> } | null {
  if (!header) return null;
  const m = /^\s*(\w+)\s*(.*)$/.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of (m[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)) params[(p[1] ?? '').toLowerCase()] = p[2] ?? '';
  return { scheme: (m[1] ?? '').toLowerCase(), params };
}

function apiBase(host: string): string {
  const h = host === DOCKER_HUB ? DOCKER_HUB_API : host;
  const plain = h.startsWith('localhost') || h.startsWith('127.');
  return `${plain ? 'http' : 'https'}://${h}`;
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const fail = (status: RegistryTestStatus, message: string, checkedManifest = false): RegistryTestResult => ({
  ok: false,
  status,
  message,
  checkedManifest,
});

/**
 * Verify a login against a registry: `GET /v2/` → follow the challenge (Bearer:
 * fetch a token from the realm with Basic auth; Basic: retry `/v2/` with it) →
 * optional `HEAD /v2/<repo>/manifests/<ref>` for `image`. Never throws; never
 * echoes the secret in `message`.
 */
export async function testRegistryLogin(
  input: { prefix: string; username: string; secret: string; image?: string },
  fetchImpl: Fetch = fetch,
  timeoutMs = 10_000,
): Promise<RegistryTestResult> {
  const host = input.prefix.split('/')[0] ?? input.prefix;
  const target = input.image ? parseImageRef(input.image) : null;
  if (target && target.host !== host) {
    return fail('error', `image host ${target.host} does not match credential host ${host}`);
  }
  const base = apiBase(host);
  const basic = `Basic ${Buffer.from(`${input.username}:${input.secret}`).toString('base64')}`;
  const req = (url: string, init: RequestInit = {}) =>
    fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  const scrub = (s: string) => (input.secret ? s.split(input.secret).join('***') : s);

  try {
    const probe = await req(`${base}/v2/`);
    let authHeader: string | null = null;
    if (probe.status === 401) {
      const ch = parseAuthChallenge(probe.headers.get('www-authenticate'));
      if (ch?.scheme === 'bearer' && ch.params.realm) {
        const url = new URL(ch.params.realm);
        if (ch.params.service) url.searchParams.set('service', ch.params.service);
        if (target) url.searchParams.set('scope', `repository:${target.repo}:pull`);
        const tok = await req(url.toString(), { headers: { Authorization: basic } });
        if (tok.status === 401 || tok.status === 403) return fail('unauthorized', 'registry rejected the username/token');
        if (!tok.ok) return fail('error', `token endpoint returned HTTP ${tok.status}`);
        const body = (await tok.json().catch(() => ({}))) as { token?: string; access_token?: string };
        const token = body.token ?? body.access_token;
        if (!token) return fail('error', 'token endpoint returned no token');
        authHeader = `Bearer ${token}`;
      } else {
        const retry = await req(`${base}/v2/`, { headers: { Authorization: basic } });
        if (retry.status === 401 || retry.status === 403) return fail('unauthorized', 'registry rejected the username/token');
        if (!retry.ok) return fail('error', `registry returned HTTP ${retry.status}`);
        authHeader = basic;
      }
    } else if (!probe.ok) {
      return fail('error', `registry returned HTTP ${probe.status} for /v2/`);
    }

    if (!target) {
      return { ok: true, status: 'ok', message: 'login accepted', checkedManifest: false };
    }
    const head = await req(`${base}/v2/${target.repo}/manifests/${target.reference}`, {
      method: 'HEAD',
      headers: { Accept: MANIFEST_ACCEPT, ...(authHeader ? { Authorization: authHeader } : {}) },
    });
    if (head.ok) return { ok: true, status: 'ok', message: `can pull ${target.repo}:${target.reference}`, checkedManifest: true };
    if (head.status === 401 || head.status === 403) {
      return fail('unauthorized', `login has no pull access to ${target.repo}`, true);
    }
    if (head.status === 404) return fail('not_found', `${target.repo}:${target.reference} not found`, true);
    return fail('error', `manifest check returned HTTP ${head.status}`, true);
  } catch (err) {
    return fail('unreachable', scrub(`could not reach ${host}: ${err instanceof Error ? err.message : String(err)}`));
  }
}
