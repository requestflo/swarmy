/**
 * Attaching a bucket to an app: which of its services get the bucket, and the
 * variables swarmy adds to each. Pure — the preview and the Undo toast read it.
 */

/**
 * The env a `buckets.attachToService` adds (and `buckets.detach` removes).
 * Mirrors `ATTACH_ENV_KEYS` in packages/trpc buckets.service.ts.
 */
export const ATTACH_ENV = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY_FILE'] as const;

export interface ServiceLike {
  id: string;
  name: string;
  stack: string;
  labels: Record<string, string>;
}

export interface AttachCandidate {
  id: string;
  /** Full service name (what attach/detach and attachments use). */
  name: string;
  /** "api", not "storefront_api". */
  short: string;
  eligible: boolean;
  /** Why it's left out ("already uses media"). */
  reason?: string;
}

/** Managed data members and swarmy's own services never take a bucket. */
const MANAGED_PREFIXES = ['swarmy.db.', 'swarmy.cache.', 'swarmy.search.', 'swarmy.vector.'];

function isManaged(labels: Record<string, string>): boolean {
  if (labels['swarmy.managed'] === 'true' || labels['swarmy.system'] === 'true') return true;
  return Object.keys(labels).some((k) => MANAGED_PREFIXES.some((p) => k.startsWith(p)));
}

export function shortName(app: string, service: string): string {
  return service.startsWith(`${app}_`) ? service.slice(app.length + 1) : service;
}

/**
 * The app's services, each marked eligible or not. A service holds at most
 * one bucket (attach refuses a second), so one already attached sits out.
 */
export function attachCandidates(
  app: string,
  services: readonly ServiceLike[],
  /** service name → the bucket it already uses */
  attachedTo: ReadonlyMap<string, string>,
): AttachCandidate[] {
  return services
    .filter((s) => s.stack === app && !isManaged(s.labels))
    .map((s) => {
      const has = attachedTo.get(s.name);
      return { id: s.id, name: s.name, short: shortName(app, s.name), eligible: !has, ...(has ? { reason: `already uses ${has}` } : {}) };
    })
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.short.localeCompare(b.short));
}

/** service name → bucket name, from every bucket's attachments. */
export function attachmentMap(buckets: ReadonlyArray<{ name: string; attachments: ReadonlyArray<{ service: string }> } | undefined>): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of buckets) for (const a of b?.attachments ?? []) out.set(a.service, b!.name);
  return out;
}

/**
 * The preview lines: `KEY=value  # note`. The key id and secret are minted on
 * Attach; `S3_PUBLIC_ENDPOINT` comes only when the org has a public S3 address.
 */
export function attachEnvLines(input: {
  endpoint: string | null;
  publicEndpoint?: string | null;
  region: string;
  bucket: string;
}): Array<{ key: string; value: string; note?: string }> {
  return [
    { key: 'S3_ENDPOINT', value: input.endpoint ?? 'http://swarmy-garage:3900' },
    ...(input.publicEndpoint ? [{ key: 'S3_PUBLIC_ENDPOINT', value: input.publicEndpoint, note: 'sign browser links with it' }] : []),
    { key: 'S3_REGION', value: input.region },
    { key: 'S3_BUCKET', value: input.bucket },
    { key: 'S3_ACCESS_KEY_ID', value: '<minted on attach>', note: 'its own key per service' },
    { key: 'S3_SECRET_ACCESS_KEY_FILE', value: '/run/secrets/…', note: 'a Docker secret, never plain text' },
  ];
}

/** "storefront-media attached to storefront · 5 variables in 2 services". */
export function attachedToast(bucket: string, app: string, services: number, variables: number = ATTACH_ENV.length): string {
  return `${bucket} attached to ${app} · ${variables} variables in ${services} service${services === 1 ? '' : 's'}`;
}
