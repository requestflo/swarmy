import { describe, expect, it } from 'bun:test';
import { checkParity, extractRoutes, normalizePath } from './check-sdk-parity';

const GO = `
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	data, _, err := c.doRaw(ctx, method, path, query, body)
}
func (s *ServicesService) Scale(ctx context.Context, id string, replicas int) (*DeploymentRef, error) {
	if err := s.client.do(ctx, "POST", "/services/"+pathEscape(id)+"/scale", nil, ScaleServiceRequest{Replicas: replicas}, &out); err != nil {
	if err := s.client.do(ctx, "DELETE", "/stacks/"+pathEscape(id)+"/connections/"+pathEscape(peer), nil, nil, &out); err != nil {
	resp, err := s.client.stream(ctx, "GET", "/services/"+pathEscape(id)+"/logs/stream", opts.values())
	data, header, err := s.client.doRaw(ctx, "GET", "/audit/export", q, nil)
`;

const TS = `
  async request<T>(method: string, path: string, opts = {}): Promise<T> {}
  list(opts?: ListOptions): Promise<ServiceList> {
    return this.http.request<ServiceList>('GET', '/services', { query: listQuery(opts) });
  }
  remove(id: string) {
    return this.http.request<{ data: Array<Removed> }>('DELETE', \`/stacks/\${encodeURIComponent(id)}\`, {
      query: { delete_data: opts.deleteData ? 'true' : undefined },
    });
  }
  purgeData(repoId: string, environment: string) {
    return this.http.request<PurgeAppDataResult>(
      'POST',
      \`/apps/\${encodeURIComponent(repoId)}/environments/\${encodeURIComponent(environment)}/purge\`,
      { body },
    );
  }
  const res = await this.http.raw('GET', '/audit/export', { query, accept: 'text/csv' });
`;

const PY = `
    def request(self, method: str, path: str, query=None, body=None) -> Any:
        resp = self._open(method, path, query, body, DEFAULT_ACCEPT, self.timeout)
    def get(self, service_id: str) -> Service:
        return Service.from_dict(self._http.request("GET", "/services/{}".format(_quote(service_id))))
    def disconnect(self, stack_id: str, peer: str) -> StackConnection:
        return self._http.request(
            "DELETE", "/stacks/{}/connections/{}".format(_quote(stack_id), _quote(peer))
        )
        raw, headers = self._http.request_raw("GET", "/audit/export", query=query)
`;

describe('extractRoutes finds each SDK call site with its inline path', () => {
  it('Go: string literals joined with pathEscape(...) by +; definitions are skipped', () => {
    expect(extractRoutes(GO)).toEqual([
      'POST /services/{}/scale',
      'DELETE /stacks/{}/connections/{}',
      'GET /services/{}/logs/stream',
      'GET /audit/export',
    ]);
  });

  it('TypeScript: plain and template literals, generics, multi-line calls', () => {
    expect(extractRoutes(TS)).toEqual([
      'GET /services',
      'DELETE /stacks/{}',
      'POST /apps/{}/environments/{}/purge',
      'GET /audit/export',
    ]);
  });

  it('Python: literals with .format(...) placeholders', () => {
    expect(extractRoutes(PY)).toEqual([
      'GET /services/{}',
      'DELETE /stacks/{}/connections/{}',
      'GET /audit/export',
    ]);
  });

  it('ignores a path held in a variable (it must be written inline)', () => {
    expect(extractRoutes('s.client.do(ctx, "POST", path, nil, body, &out)')).toEqual([]);
  });
});

describe('checkParity: every spec route has a method in every SDK, or an allowlisted reason', () => {
  const spec = {
    paths: {
      '/nodes/{id}': { get: {}, delete: {} },
      '/nodes/{id}/cordon': { post: {} },
    },
  };
  const all = ['GET /nodes/{}', 'DELETE /nodes/{}'];

  it('passes when each route is called or allowlisted', () => {
    const r = checkParity(
      spec,
      { go: all, python: all, typescript: all },
      {
        'POST /nodes/{id}/cordon': { sdks: ['go', 'python', 'typescript'], reason: 'alias' },
      },
    );
    expect(r.missing).toEqual({ go: [], python: [], typescript: [] });
    expect(r.unknown).toEqual({ go: [], python: [], typescript: [] });
    expect(r.stale).toEqual([]);
  });

  it('reports a missing method per SDK, a call the spec lacks, and a stale allowlist entry', () => {
    const r = checkParity(
      spec,
      {
        go: [...all, 'POST /nodes/{}/cordon'],
        python: ['GET /nodes/{}'],
        typescript: [...all, 'GET /nodez/{}'],
      },
      {
        'POST /nodes/{id}/cordon': { sdks: ['go'], reason: 'alias' },
        'GET /gone': { sdks: ['go'], reason: 'x' },
      },
    );
    expect(r.missing).toEqual({
      go: [],
      python: ['DELETE /nodes/{id}', 'POST /nodes/{id}/cordon'],
      typescript: ['POST /nodes/{id}/cordon'],
    });
    expect(r.unknown.typescript).toEqual(['GET /nodez/{}']);
    expect(r.stale).toEqual([
      'POST /nodes/{id}/cordon: go has a method for it now',
      'GET /gone: not in the spec any more',
    ]);
  });

  it('compares path params by position, not name', () => {
    expect(normalizePath('/apps/{repoId}/environments/{environment}/purge')).toBe(
      '/apps/{}/environments/{}/purge',
    );
  });
});
