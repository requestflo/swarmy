/**
 * Sentry-compatible ingest + artifact upload (epic-developer-platform §6).
 *
 * Existing Sentry SDKs work unchanged: a DSN `https://<key>@<controller>/<id>`
 * makes them POST to
 *
 *   /api/<id>/envelope/   (every current SDK; gzip/deflate/br/zstd bodies)
 *   /api/<id>/store/      (legacy single-event endpoint)
 *
 * Public by design (browser SDKs post cross-origin with the key in the query
 * string), authenticated per project by the DSN key and rate-limited per
 * project. The pipeline itself lives in @swarmy/trpc `services/errors/`.
 *
 * Source maps: `POST /errors/v1/stacks/:stack/releases/:release/files`
 * (multipart `file` fields, or JSON `{ files: [{ name, content }] }`), bearer
 * = a swarmy API key with `write` scope and an admin creator. This is what
 * `swarmy sourcemaps upload` and the CI build step call. `release` `_` means
 * release-less (matched for every release; safe with debug ids).
 *
 * Numeric project ids never collide with `/api/trpc`, `/api/v1`, `/api/auth`.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import {
  ingest,
  MAX_ARTIFACT_BYTES,
  MAX_DECOMPRESSED_BYTES,
  resolveOrgContextFromApiKey,
  systemContext,
  uploadArtifacts,
} from '@swarmy/trpc';
import { hub } from './gateway';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'content-type, content-encoding, x-sentry-auth, authorization, sentry-trace, baggage, x-requested-with',
  'Access-Control-Expose-Headers': 'x-sentry-rate-limits, retry-after, x-sentry-error',
  'Access-Control-Max-Age': '86400',
};

/**
 * Compressed request cap (the decompressed cap is enforced by the parser).
 * Enforced by `bodyLimit` BEFORE the body is read, so a chunked request with
 * no Content-Length can't stream past it either.
 */
export const ERRORS_INGEST_MAX_BODY_BYTES = MAX_DECOMPRESSED_BYTES;
const MAX_REQUEST_BYTES = ERRORS_INGEST_MAX_BODY_BYTES;
/**
 * Source-map upload cap for one request (several files, each ≤ MAX_ARTIFACT_BYTES).
 * Checked by `bodyLimit` before the JSON/multipart body is parsed.
 */
export const ARTIFACT_UPLOAD_MAX_BODY_BYTES = 64 * 1024 * 1024;

// Per-route (not `use('*')`): this app is mounted at `/`, so a wildcard
// middleware would cap every controller route.
const ingestLimit = bodyLimit({
  maxSize: ERRORS_INGEST_MAX_BODY_BYTES,
  onError: (c) => c.json({ detail: 'request too large' }, 413, CORS),
});
const uploadLimit = bodyLimit({
  maxSize: ARTIFACT_UPLOAD_MAX_BODY_BYTES,
  onError: (c) => c.json({ detail: 'upload too large' }, 413),
});

async function handle(c: Context, kind: 'envelope' | 'store'): Promise<Response> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_REQUEST_BYTES) return c.json({ detail: 'request too large' }, 413, CORS);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.length > MAX_REQUEST_BYTES) return c.json({ detail: 'request too large' }, 413, CORS);
  const url = new URL(c.req.url);
  const deps = { db: prisma, hub, auth: authRegistry.getAuth() };
  const res = await ingest(
    { db: prisma, contextFor: (orgId) => systemContext(deps, orgId) },
    {
      projectId: c.req.param('project') ?? '',
      kind,
      body,
      contentEncoding: c.req.header('content-encoding') ?? null,
      authHeader: c.req.header('x-sentry-auth') ?? c.req.header('authorization') ?? null,
      query: url.searchParams,
    },
  ).catch(() => ({ status: 500, body: { detail: 'ingest failed' } as Record<string, unknown>, headers: undefined }));
  return c.json(res.body, res.status as 200, { ...CORS, ...(res.headers ?? {}) });
}

export const errorsIngestApp = new Hono();

for (const kind of ['envelope', 'store'] as const) {
  for (const path of [`/api/:project{[0-9]+}/${kind}/`, `/api/:project{[0-9]+}/${kind}`]) {
    errorsIngestApp.options(path, (c) => c.body(null, 204, CORS));
    errorsIngestApp.post(path, ingestLimit, (c) => handle(c, kind));
  }
}

/* ----------------------------------------------------------------------------
 * Artifact upload (source maps from CI / `swarmy sourcemaps upload`)
 * ------------------------------------------------------------------------- */

async function readFiles(c: Context): Promise<{ name: string; content: string }[]> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const json = (await c.req.json().catch(() => null)) as { files?: { name?: unknown; content?: unknown }[] } | null;
    return (json?.files ?? [])
      .filter((f) => typeof f.name === 'string' && typeof f.content === 'string')
      .map((f) => {
        if (Buffer.byteLength(f.content as string) > MAX_ARTIFACT_BYTES) throw new Error(`${f.name as string} is larger than 15 MB`);
        return { name: f.name as string, content: f.content as string };
      });
  }
  const form = await c.req.formData();
  const out: { name: string; content: string }[] = [];
  for (const [field, entry] of form.entries()) {
    const value = entry as unknown as File | string;
    if (typeof value === 'string') continue;
    if (value.size > MAX_ARTIFACT_BYTES) throw new Error(`${value.name} is larger than 15 MB`);
    // Field name `file` → the upload's own filename; any other field name IS the artifact name.
    const name = field === 'file' || field === 'files' ? value.name : field;
    out.push({ name, content: await value.text() });
  }
  return out;
}

errorsIngestApp.post('/errors/v1/stacks/:stack/releases/:release/files', uploadLimit, async (c) => {
  const key = c.req.header('authorization') ?? '';
  const resolved = key
    ? await resolveOrgContextFromApiKey({ db: prisma, hub, auth: authRegistry.getAuth() }, key).catch(() => null)
    : null;
  if (!resolved) return c.json({ detail: 'a swarmy API key is required (Authorization: Bearer swk_…)' }, 401);
  if (!resolved.apiKey.scopes.includes('write')) return c.json({ detail: 'this API key is read-only' }, 403);
  if (resolved.ctx.membership.role === 'member') return c.json({ detail: 'uploading source maps needs an admin key' }, 403);
  let files: { name: string; content: string }[];
  try {
    files = await readFiles(c);
  } catch (e) {
    return c.json({ detail: e instanceof Error ? e.message : 'bad upload' }, 400);
  }
  const release = c.req.param('release') === '_' ? '' : decodeURIComponent(c.req.param('release'));
  try {
    const out = await uploadArtifacts(resolved.ctx, { stack: c.req.param('stack'), release, files });
    return c.json(out, 201);
  } catch (e) {
    return c.json({ detail: e instanceof Error ? e.message : 'upload failed' }, 400);
  }
});
