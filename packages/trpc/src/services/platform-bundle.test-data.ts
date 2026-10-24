/**
 * Test data for the offline-bundle tests: a tiny tar writer, a one-image OCI
 * layout, and an in-memory `registry:2` (the distribution API subset the
 * pusher speaks). Not imported by production code.
 */
import { createHash } from 'node:crypto';

const enc = new TextEncoder();
export const bytes = (s: string | Uint8Array): Uint8Array => (typeof s === 'string' ? enc.encode(s) : s);
export const digestOf = (b: Uint8Array): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;

function header(name: string, size: number, type: string, prefix = ''): Uint8Array {
  const h = new Uint8Array(512);
  h.set(enc.encode(name.slice(0, 100)), 0);
  h.set(enc.encode('0000644\0'), 100);
  h.set(enc.encode(`${size.toString(8).padStart(11, '0')}\0`), 124);
  h.set(enc.encode(type), 156);
  h.set(enc.encode('ustar\x0000'), 257);
  if (prefix) h.set(enc.encode(prefix), 345);
  h.set(enc.encode('        '), 148);
  const sum = h.reduce((a, b) => a + b, 0);
  h.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return h;
}

const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);

/** `<len> key=value\n`, where len counts the whole record (its own digits too). */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let n = body.length + 1;
  while (String(n).length + body.length !== n) n++;
  return `${n}${body}`;
}

/** A tar of `files`; names over 100 chars go in a pax `path` record (as GNU tar and bsdtar do). */
export function tarOf(files: Array<[string, string | Uint8Array]>, opts: { longNames?: 'pax' | 'gnu' } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, body] of files) {
    const data = bytes(body);
    if (name.length > 100) {
      const rec = enc.encode(opts.longNames === 'gnu' ? `${name}\0` : paxRecord('path', name));
      parts.push(header(opts.longNames === 'gnu' ? '././@LongLink' : 'PaxHeader', rec.length, opts.longNames === 'gnu' ? 'L' : 'x'), rec, pad(rec.length));
    }
    parts.push(header(name, data.length, '0'), data, pad(data.length));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One multi-arch-shaped image: index → image manifest → config + one layer. */
export function ociImage(seed: string): { index: string; blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  const put = (b: Uint8Array) => {
    const d = digestOf(b);
    blobs.set(d, b);
    return d;
  };
  const layer = bytes(`layer-${seed}`);
  const config = bytes(JSON.stringify({ architecture: 'amd64', os: 'linux', seed }));
  const manifest = bytes(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: put(config), size: config.length },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: put(layer), size: layer.length }],
    }),
  );
  const md = put(manifest);
  const index = bytes(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ digest: md, size: manifest.length, platform: { os: 'linux', architecture: 'amd64' } }] }));
  return { index: put(index), blobs };
}

/** Tar entries for a layout holding `images` under `swarmy-bundle/oci/`. */
export function layoutEntries(images: Array<ReturnType<typeof ociImage>>): Array<[string, Uint8Array]> {
  const out: Array<[string, Uint8Array]> = [];
  for (const img of images) for (const [d, b] of img.blobs) out.push([`swarmy-bundle/oci/blobs/${d.replace(':', '/')}`, b]);
  return out;
}

/** An in-memory registry: blobs + manifests per repo, basic-auth checked, every request logged. */
export function fakeRegistry(authorization: string | null = null) {
  const blobs = new Map<string, Set<string>>();
  const manifests = new Map<string, string>();
  const log: string[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    log.push(`${method} ${u.host}${u.pathname}${u.search}`);
    if (authorization && new Headers(init.headers).get('authorization') !== authorization) return new Response('denied', { status: 401 });
    const m = /^\/v2\/(.+)\/(blobs|manifests)\/(uploads\/)?(.*)$/.exec(u.pathname);
    if (u.pathname === '/v2/') return new Response('{}', { status: 200 });
    if (!m) return new Response('nope', { status: 404 });
    const [, repo, kind, upload, ref] = m as unknown as [string, string, string, string | undefined, string];
    const held = blobs.get(repo) ?? new Set<string>();
    blobs.set(repo, held);
    if (kind === 'blobs' && method === 'HEAD') return new Response(null, { status: held.has(ref) ? 200 : 404 });
    if (kind === 'blobs' && upload && method === 'POST') {
      const mount = u.searchParams.get('mount');
      if (mount && blobs.get(u.searchParams.get('from') ?? '')?.has(mount)) {
        held.add(mount);
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 202, headers: { location: `http://elsewhere:5000/v2/${repo}/blobs/uploads/u1?_state=x` } });
    }
    if (kind === 'blobs' && upload && method === 'PUT') {
      const body = new Uint8Array(await new Response(init.body).arrayBuffer());
      const want = u.searchParams.get('digest') ?? '';
      if (digestOf(body) !== want) return new Response('DIGEST_INVALID', { status: 400 });
      held.add(want);
      return new Response(null, { status: 201 });
    }
    if (kind === 'manifests' && method === 'PUT') {
      const body = new Uint8Array(await new Response(init.body).arrayBuffer());
      manifests.set(`${repo}:${ref}`, digestOf(body));
      return new Response(null, { status: 201, headers: { 'docker-content-digest': digestOf(body) } });
    }
    return new Response('unsupported', { status: 405 });
  };
  return { fetchFn, blobs, manifests, log };
}
