/**
 * Image-ref splitting + registry-credential matching: PURE, shared by the
 * controller (the hub's pull-auth decorator) and the dashboard ("Which
 * credentials will this image use?"), so both answer the question the same way.
 */

export const DOCKER_HUB = 'docker.io';
/** Hostnames that all mean Docker Hub; folded to `docker.io`. */
export const DOCKER_HUB_ALIASES: ReadonlySet<string> = new Set([
  DOCKER_HUB,
  'index.docker.io',
  'registry-1.docker.io',
  'registry.hub.docker.com',
  'hub.docker.com',
]);

/** Does this first path segment name a registry host (vs a Hub namespace)? */
export function isRegistryHostSegment(seg: string): boolean {
  return seg.includes('.') || seg.includes(':') || seg === 'localhost';
}

/**
 * Split an image ref into its registry host + repository path, tag/digest
 * dropped. Docker Hub shorthands resolve like `docker pull` does:
 * `nginx` → `docker.io/library/nginx`, `me/app:1` → `docker.io/me/app`.
 */
export function splitImageRef(image: string): { host: string; repo: string; reference: string } {
  let ref = image.trim();
  let reference = 'latest';
  const at = ref.indexOf('@');
  if (at >= 0) {
    reference = ref.slice(at + 1);
    ref = ref.slice(0, at);
  }
  const parts = ref.split('/');
  let host = DOCKER_HUB;
  if (parts.length > 1 && isRegistryHostSegment(parts[0] ?? '')) host = (parts.shift() ?? '').toLowerCase();
  if (DOCKER_HUB_ALIASES.has(host)) host = DOCKER_HUB;
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
  const { host, repo } = splitImageRef(image);
  const full = `${host}/${repo}`;
  let best: C | null = null;
  for (const c of creds) {
    if (full === c.prefix || full.startsWith(`${c.prefix}/`)) {
      if (!best || c.prefix.length > best.prefix.length) best = c;
    }
  }
  return best;
}
