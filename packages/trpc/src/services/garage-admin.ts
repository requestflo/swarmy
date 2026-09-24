/**
 * Garage admin API, both generations, behind one call shape.
 *
 * swarmy's call sites speak the v1 vocabulary (`GET /bucket?list`,
 * `POST /bucket/allow`, `POST /layout` with a role-change array, …). Garage v2
 * replaced that REST API wholesale with RPC-style `/v2/<Operation>` endpoints
 * (DELETE/PUT became POST, layout staging wraps the changes in `{roles}`), and
 * v1 endpoints no longer answer. Rather than fork every call site, a call is
 * written once and translated here for the engine the org's store runs — so a
 * cluster keeps working on v1 until it is migrated, and on v2 after. Response
 * bodies are field-compatible for everything swarmy reads (see
 * `parseGarageHealth` for the one rename, `storageNodesOk` → `storageNodesUp`).
 *
 * Pure — unit-tested against the v2 OpenAPI operation list.
 */

export type GarageMajor = 1 | 2;

/** What pre-v2 clusters run (no `engineImage` recorded on their row). */
export const LEGACY_GARAGE_IMAGE = 'dxflrs/garage:v1.0.1';

/** Garage major version from an image ref (`dxflrs/garage:v2.4.1` → 2); unknown ⇒ 1. */
export function garageMajorOf(image: string | null | undefined): GarageMajor {
  const tag = (image ?? LEGACY_GARAGE_IMAGE).split('@')[0]!.split(':').pop() ?? '';
  const m = /^v?(\d+)\./.exec(tag);
  return m && Number(m[1]) >= 2 ? 2 : 1;
}

/** A call in v1 vocabulary: path WITHOUT the `/v1` prefix, e.g. `/bucket?id=…`. */
export interface GarageCall {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: string;
}

/** A concrete request: path WITH its version prefix (v2 only ever uses GET/POST). */
export interface GarageRequest {
  method: GarageCall['method'];
  path: string;
  body?: string;
}

function split(path: string): { route: string; query: string } {
  const i = path.indexOf('?');
  return i < 0 ? { route: path, query: '' } : { route: path.slice(0, i), query: path.slice(i + 1) };
}

function hasParam(query: string, name: string): boolean {
  return query.split('&').some((kv) => kv === name || kv.startsWith(`${name}=`));
}

/** Translate a v1-vocabulary call for the target engine. Throws on an unmapped call. */
export function toGarageRequest(call: GarageCall, major: GarageMajor): GarageRequest {
  if (major === 1) {
    return { method: call.method, path: `/v1${call.path}`, ...(call.body ? { body: call.body } : {}) };
  }
  const { route, query } = split(call.path);
  const q = query ? `?${query}` : '';
  const withBody = (method: 'GET' | 'POST', path: string, body = call.body): GarageRequest => ({
    method,
    path,
    ...(body ? { body } : {}),
  });
  switch (`${call.method} ${route}`) {
    case 'GET /bucket':
      return hasParam(query, 'list') ? withBody('GET', '/v2/ListBuckets') : withBody('GET', `/v2/GetBucketInfo${q}`);
    case 'POST /bucket':
      return withBody('POST', '/v2/CreateBucket');
    case 'DELETE /bucket':
      return withBody('POST', `/v2/DeleteBucket${q}`);
    case 'PUT /bucket':
      return withBody('POST', `/v2/UpdateBucket${q}`);
    case 'POST /bucket/allow':
      return withBody('POST', '/v2/AllowBucketKey');
    case 'POST /bucket/deny':
      return withBody('POST', '/v2/DenyBucketKey');
    case 'GET /key':
      return hasParam(query, 'list') ? withBody('GET', '/v2/ListKeys') : withBody('GET', `/v2/GetKeyInfo${q}`);
    case 'POST /key':
      return withBody('POST', '/v2/CreateKey');
    case 'DELETE /key':
      return withBody('POST', `/v2/DeleteKey${q}`);
    case 'GET /status':
      return withBody('GET', '/v2/GetClusterStatus');
    case 'GET /health':
      return withBody('GET', '/v2/GetClusterHealth');
    case 'GET /layout':
      return withBody('GET', '/v2/GetClusterLayout');
    case 'POST /layout':
      // v1 takes the role-change array bare; v2 wants `{ roles: [...] }`.
      return withBody('POST', '/v2/UpdateClusterLayout', call.body ? `{"roles":${call.body}}` : '{"roles":[]}');
    case 'POST /layout/apply':
      return withBody('POST', '/v2/ApplyClusterLayout');
    case 'POST /connect':
      return withBody('POST', '/v2/ConnectClusterNodes');
    default:
      throw new Error(`no Garage v2 mapping for ${call.method} ${route}`);
  }
}

/** URL prefix to which a bucket id is appended to fetch its info (bucket-dump script). */
export function bucketInfoUrlPrefix(adminRoot: string, major: GarageMajor): string {
  return major === 2 ? `${adminRoot}/v2/GetBucketInfo?id=` : `${adminRoot}/v1/bucket?id=`;
}
