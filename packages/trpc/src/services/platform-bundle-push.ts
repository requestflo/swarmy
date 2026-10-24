/**
 * Push one image of an offline bundle's OCI layout into the built-in registry
 * over the distribution API (the controller reaches `registry:2` on the swarm
 * routing mesh, `images-local.ts`). Digest-preserving: the bytes go up as they
 * are, so the index digest the signed manifest names is the digest that lands.
 *
 * Trust chain: the release key signs platform.json → it names each image's
 * index digest → every manifest read from the bundle is hashed here before it
 * is pushed → each blob is uploaded with `?digest=`, which the registry checks.
 */
import { createHash } from 'node:crypto';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** A blob of the layout by digest (`oci/blobs/sha256/<hex>`), or null when the bundle lacks it. */
export type LayoutBlob = (digest: string) => Blob | null;

export interface RegistryTarget {
  /** `http://<node>:5000` — a base that answered `GET /v2/`. */
  base: string;
  /** `Basic …` for the org's registry login, or null. */
  authorization: string | null;
}

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

interface Descriptor {
  digest: string;
  mediaType?: string;
  urls?: string[];
}

/** An upload `Location` (absolute or relative) on OUR base — the registry may name a host we can't reach. */
export function uploadUrl(base: string, location: string, digest: string): string {
  const u = new URL(location, `${base}/`);
  const b = new URL(base);
  u.protocol = b.protocol;
  u.host = b.host;
  u.searchParams.set('digest', digest);
  return u.toString();
}

export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export class RegistryPusher {
  /** digest → a repo that already holds it (cross-repo mount instead of a re-upload). */
  private readonly holders = new Map<string, string>();

  constructor(
    private readonly reg: RegistryTarget,
    private readonly blob: LayoutBlob,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  /** Push the image whose top manifest is `digest` as `<repo>:<tag>`. */
  async pushImage(repo: string, tag: string, digest: string): Promise<void> {
    await this.pushManifest(repo, digest, tag);
  }

  private async call(method: string, path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.reg.base}${path}`;
    const headers = new Headers(init.headers);
    if (this.reg.authorization) headers.set('authorization', this.reg.authorization);
    return this.fetchFn(url, { ...init, method, headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  private async expect(res: Response, ok: number[], what: string): Promise<Response> {
    if (ok.includes(res.status)) return res;
    const body = await res.text().catch(() => '');
    throw new Error(`the registry answered HTTP ${res.status} to ${what}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  private async pushManifest(repo: string, digest: string, tag?: string): Promise<void> {
    const src = this.blob(digest);
    if (!src) throw new Error(`the bundle is missing manifest ${digest}`);
    const bytes = new Uint8Array(await src.arrayBuffer());
    if (sha256Digest(bytes) !== digest) throw new Error(`manifest ${digest} in the bundle does not match its digest`);
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as {
      mediaType?: string;
      manifests?: Descriptor[];
      config?: Descriptor;
      layers?: Descriptor[];
    };
    if (Array.isArray(doc.manifests)) {
      for (const child of doc.manifests) await this.pushManifest(repo, child.digest);
    } else {
      for (const d of [doc.config, ...(doc.layers ?? [])]) if (d?.digest) await this.pushBlob(repo, d);
    }
    const mediaType = doc.mediaType ?? (Array.isArray(doc.manifests) ? OCI_INDEX : OCI_MANIFEST);
    const ref = tag ?? digest;
    const res = await this.expect(
      await this.call('PUT', `/v2/${repo}/manifests/${ref}`, { headers: { 'content-type': mediaType }, body: bytes }),
      [201],
      `PUT ${repo}:${ref}`,
    );
    const landed = res.headers.get('docker-content-digest');
    if (landed && landed !== digest) throw new Error(`${repo}:${ref} landed as ${landed}, not ${digest}`);
  }

  private async pushBlob(repo: string, d: Descriptor): Promise<void> {
    const head = await this.call('HEAD', `/v2/${repo}/blobs/${d.digest}`);
    if (head.status === 200) return;
    const src = this.blob(d.digest);
    if (!src) {
      // A foreign (non-distributable) layer is fetched from its URLs by the puller.
      if (d.urls?.length) return;
      throw new Error(`the bundle is missing blob ${d.digest}`);
    }
    const from = this.holders.get(d.digest);
    const q = from ? `?mount=${encodeURIComponent(d.digest)}&from=${encodeURIComponent(from)}` : '';
    const start = await this.expect(await this.call('POST', `/v2/${repo}/blobs/uploads/${q}`), [201, 202], `start upload ${d.digest}`);
    if (start.status === 202) {
      const location = start.headers.get('location');
      if (!location) throw new Error(`the registry gave no upload location for ${d.digest}`);
      await this.expect(
        await this.call(
          'PUT',
          uploadUrl(this.reg.base, location, d.digest),
          { headers: { 'content-type': 'application/octet-stream', 'content-length': String(src.size) }, body: src },
          60 * 60_000,
        ),
        [201],
        `upload ${d.digest}`,
      );
    }
    this.holders.set(d.digest, repo);
  }
}
