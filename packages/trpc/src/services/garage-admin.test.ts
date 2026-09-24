import { describe, expect, it } from 'bun:test';
import { bucketInfoUrlPrefix, garageMajorOf, toGarageRequest, type GarageCall } from './garage-admin';

/** Every operation in Garage's published admin v2 OpenAPI spec (method + path). */
const V2_OPERATIONS = new Set<string>(["GET /check", "GET /health", "GET /metrics", "GET /v2/GetAdminTokenInfo", "GET /v2/GetBucketInfo", "GET /v2/GetClusterHealth", "GET /v2/GetClusterLayout", "GET /v2/GetClusterLayoutHistory", "GET /v2/GetClusterStatistics", "GET /v2/GetClusterStatus", "GET /v2/GetCurrentAdminTokenInfo", "GET /v2/GetKeyInfo", "GET /v2/GetNodeInfo", "GET /v2/GetNodeStatistics", "GET /v2/InspectObject", "GET /v2/ListAdminTokens", "GET /v2/ListBlockErrors", "GET /v2/ListBuckets", "GET /v2/ListKeys", "POST /v2/AddBucketAlias", "POST /v2/AllowBucketKey", "POST /v2/ApplyClusterLayout", "POST /v2/CleanupIncompleteUploads", "POST /v2/ClusterLayoutSkipDeadNodes", "POST /v2/ConnectClusterNodes", "POST /v2/CreateAdminToken", "POST /v2/CreateBucket", "POST /v2/CreateKey", "POST /v2/CreateMetadataSnapshot", "POST /v2/DeleteAdminToken", "POST /v2/DeleteBucket", "POST /v2/DeleteKey", "POST /v2/DenyBucketKey", "POST /v2/GetBlockInfo", "POST /v2/GetWorkerInfo", "POST /v2/GetWorkerVariable", "POST /v2/ImportKey", "POST /v2/LaunchRepairOperation", "POST /v2/ListWorkers", "POST /v2/PreviewClusterLayoutChanges", "POST /v2/PurgeBlocks", "POST /v2/RemoveBucketAlias", "POST /v2/RetryBlockResync", "POST /v2/RevertClusterLayout", "POST /v2/SetWorkerVariable", "POST /v2/UpdateAdminToken", "POST /v2/UpdateBucket", "POST /v2/UpdateClusterLayout", "POST /v2/UpdateKey"]);

/** Every call swarmy makes, in v1 vocabulary (buckets.service + storage-reconcile + render). */
const CALLS: GarageCall[] = [
  { method: 'GET', path: '/bucket?list' },
  { method: 'GET', path: '/bucket?id=abc' },
  { method: 'POST', path: '/bucket', body: '{"globalAlias":"media"}' },
  { method: 'DELETE', path: '/bucket?id=abc' },
  { method: 'PUT', path: '/bucket?id=abc', body: '{"quotas":{"maxSize":1}}' },
  { method: 'POST', path: '/bucket/allow', body: '{}' },
  { method: 'POST', path: '/bucket/deny', body: '{}' },
  { method: 'GET', path: '/key?list' },
  { method: 'GET', path: '/key?id=GK1&showSecretKey=true' },
  { method: 'POST', path: '/key', body: '{"name":"k"}' },
  { method: 'DELETE', path: '/key?id=GK1' },
  { method: 'GET', path: '/status' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/layout' },
  { method: 'POST', path: '/layout', body: '[{"id":"n1","zone":"z","capacity":1,"tags":[]}]' },
  { method: 'POST', path: '/layout/apply', body: '{"version":2}' },
  { method: 'POST', path: '/connect', body: '["id@1.2.3.4:3901"]' },
];

describe('garageMajorOf', () => {
  it('reads the major from the tag; unknown/absent is the legacy v1 engine', () => {
    expect(garageMajorOf('dxflrs/garage:v2.4.1')).toBe(2);
    expect(garageMajorOf('dxflrs/garage:v1.0.1')).toBe(1);
    expect(garageMajorOf('dxflrs/garage:v2.4.1@sha256:abc')).toBe(2);
    expect(garageMajorOf(null)).toBe(1);
    expect(garageMajorOf('dxflrs/garage:latest')).toBe(1);
  });
});

describe('toGarageRequest', () => {
  it('v1: prefixes /v1 and passes the call through untouched', () => {
    expect(toGarageRequest({ method: 'DELETE', path: '/bucket?id=abc' }, 1)).toEqual({ method: 'DELETE', path: '/v1/bucket?id=abc' });
  });

  it('v2: EVERY call swarmy makes maps to a real operation in the v2 spec', () => {
    for (const c of CALLS) {
      const r = toGarageRequest(c, 2);
      const route = r.path.split('?')[0];
      expect(V2_OPERATIONS.has(`${r.method} ${route}`)).toBe(true);
    }
  });

  it('v2: keeps query params, turns DELETE/PUT into POST, wraps layout staging in {roles}', () => {
    expect(toGarageRequest({ method: 'DELETE', path: '/bucket?id=abc' }, 2)).toEqual({ method: 'POST', path: '/v2/DeleteBucket?id=abc' });
    expect(toGarageRequest({ method: 'GET', path: '/key?id=GK1&showSecretKey=true' }, 2).path).toBe('/v2/GetKeyInfo?id=GK1&showSecretKey=true');
    expect(toGarageRequest({ method: 'GET', path: '/bucket?list' }, 2).path).toBe('/v2/ListBuckets');
    const layout = toGarageRequest({ method: 'POST', path: '/layout', body: '[{"id":"n1","remove":true}]' }, 2);
    expect(layout.path).toBe('/v2/UpdateClusterLayout');
    expect(JSON.parse(layout.body!)).toEqual({ roles: [{ id: 'n1', remove: true }] });
  });

  it('an unmapped call fails loudly instead of hitting a dead v1 path', () => {
    expect(() => toGarageRequest({ method: 'GET', path: '/nope' }, 2)).toThrow();
  });

  it('bucket-info URL prefix per engine', () => {
    expect(bucketInfoUrlPrefix('http://g:3903', 1)).toBe('http://g:3903/v1/bucket?id=');
    expect(bucketInfoUrlPrefix('http://g:3903', 2)).toBe('http://g:3903/v2/GetBucketInfo?id=');
  });
});
