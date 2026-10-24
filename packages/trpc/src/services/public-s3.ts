/**
 * The org's public S3 endpoint — where browsers reach object storage.
 *
 * Inside the swarm, Garage answers at `http://swarmy-garage:3900`, a name only
 * the overlay resolves; a URL signed for it is useless in a browser (SigV4
 * signs the Host, so a link can't be re-pointed afterwards). The org setting
 * is the public S3 hostname (`buckets.setPublicDomain`, kept on the store's
 * swarm-kv document; derived as `s3.<dashboard domain>` when unset), served
 * by the Caddy edges over HTTPS for every bucket whose reach is Public.
 *
 * Two signers use it:
 *  - swarmy's own presigned links (`buckets.presignUrl`) sign for the address
 *    the bucket is really reachable on — public, else a mesh edge, else the
 *    cluster (`presignTarget`);
 *  - attached apps get it as `S3_PUBLIC_ENDPOINT`, so the presigned upload
 *    and download links THEY mint for browsers sign the public host too.
 */
import type { OrgContext } from '../context';
import { publicS3DomainFor } from './bucket-access.service';
import { orgDashboardDomain } from './ingress.service';

/** `s3.example.com` → `https://s3.example.com` (the edges serve it over HTTPS only). Pure. */
export function publicS3Origin(domain: string | null | undefined): string | null {
  const d = domain?.trim();
  return d ? `https://${d}` : null;
}

export type PresignReach = 'internet' | 'mesh' | 'cluster';

/**
 * Which origin to sign a presigned link for, from a bucket's live endpoints:
 * the public one when the bucket is Public, else the first mesh edge, else
 * none (the presigner's in-cluster default). Pure.
 */
export function presignTarget(endpoints: { public: string | null; mesh: readonly string[] }): {
  endpoint: string | undefined;
  reachableFrom: PresignReach;
} {
  if (endpoints.public) return { endpoint: new URL(endpoints.public).origin, reachableFrom: 'internet' };
  if (endpoints.mesh[0]) return { endpoint: new URL(endpoints.mesh[0]).origin, reachableFrom: 'mesh' };
  return { endpoint: undefined, reachableFrom: 'cluster' };
}

/** The org's public S3 endpoint, or null when there is no public hostname to derive. Never throws. */
export async function publicS3EndpointFor(ctx: OrgContext): Promise<string | null> {
  try {
    const dashboard = await orgDashboardDomain(ctx).catch(() => undefined);
    return publicS3Origin((await publicS3DomainFor(ctx, dashboard)).domain);
  } catch {
    return null;
  }
}
