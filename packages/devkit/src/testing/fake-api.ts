/**
 * A tiny in-process stand-in for the controller's REST API — enough of
 * `/api/v1` for the CLI and MCP tests. Records every request.
 */
export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

export interface FakeApi {
  fetch: (req: Request) => Promise<Response>;
  calls: FakeCall[];
}

const app = {
  repo_id: 'repo_1',
  url: 'https://github.com/acme/shop.git',
  full_name: 'acme/shop',
  branch: 'main',
  config_path: 'swarmy.yaml',
  app_name: 'shop',
  require_approval: false,
  enforce_drift: false,
  environments: [
    {
      environment: 'production',
      branch: 'main',
      stack: 'shop',
      latest_plan_id: 'plan_1',
      latest_plan_status: 'applied',
      latest_sha: 'abcdef1234567',
      latest_created_at: '2026-09-24T10:00:00.000Z',
      kept_volumes: [],
    },
  ],
  previews: [],
  drift: null,
};

const plan = {
  id: 'plan_1',
  repo_id: 'repo_1',
  environment: 'production',
  stack: 'shop',
  sha: 'abcdef1234567',
  trigger: 'push',
  pr_number: null,
  status: 'applied',
  plan_status: 'ready',
  counts: { auto: 2, confirm: 0, blocked: 0 },
  actions: [],
  issues: [],
  error: null,
  confirmed_ids: [],
  markdown: '### plan',
  created_at: '2026-09-24T10:00:00.000Z',
  applied_at: '2026-09-24T10:01:00.000Z',
};

const services = [
  {
    id: 'svc_web',
    name: 'shop_web',
    image: 'registry.local/shop/web:abc',
    status: 'running',
    replicas: { desired: 2, running: 1 },
    ingress_enabled: true,
    node_id: null,
    stack_id: 'shop',
    updated_at: '2026-09-24T10:00:00.000Z',
  },
  {
    id: 'svc_worker',
    name: 'shop_worker',
    image: 'registry.local/shop/web:abc',
    status: 'running',
    replicas: { desired: 1, running: 1 },
    ingress_enabled: false,
    node_id: null,
    stack_id: 'shop',
    updated_at: '2026-09-24T10:00:00.000Z',
  },
];

const stack = {
  id: 'stk_1',
  name: 'shop',
  service_count: 2,
  status: 'running',
  updated_at: '2026-09-24T10:00:00.000Z',
};

const env = {
  service_id: 'svc_web',
  service: 'shop_web',
  secrets_readable: false,
  vars: [
    { key: 'NODE_ENV', value: 'production', secret: false, delivery: null, withheld: false, error: null },
    { key: 'STRIPE_KEY', value: null, secret: true, delivery: 'env', withheld: true, error: null },
  ],
};

export function fakeApi(opts: { scopes?: string[]; key?: string } = {}): FakeApi {
  const calls: FakeCall[] = [];
  const scopes = opts.scopes ?? ['read'];
  const key = opts.key ?? 'swk_test';
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const problem = (status: number, detail: string, code?: string) =>
    new Response(JSON.stringify({ type: 'about:blank', title: 'Error', status, detail, ...(code ? { swarmy_code: code } : {}) }), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    });

  return {
    calls,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname.replace(/^\/api\/v1/, '');
      const multipart = (req.headers.get('content-type') ?? '').startsWith('multipart/form-data');
      const body =
        req.method === 'GET'
          ? null
          : multipart
            ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === 'string' ? v : (v as File).name]))
            : await req.json().catch(() => null);
      const auth = req.headers.get('authorization');
      calls.push({ method: req.method, path: p + url.search, body, auth });
      if (auth !== `Bearer ${key}`) return problem(401, 'Invalid or revoked API key');
      const write = scopes.includes('write');
      const m = (re: RegExp) => re.exec(p);

      if (req.method === 'GET' && p === '/me') {
        return json({
          org_id: 'org_1',
          user: { id: 'u1', email: 'dev@acme.test', name: 'Dev' },
          role: 'admin',
          credential: { kind: 'api_key', id: 'key_1', scopes },
        });
      }
      if (req.method === 'GET' && p === '/apps') return json({ data: [app], next_cursor: null });
      if (req.method === 'GET' && p === '/apps/plans/plan_1') return json(plan);
      if (req.method === 'GET' && p === '/services') return json({ data: services, next_cursor: null });
      if (req.method === 'GET' && p === '/stacks') return json({ data: [stack], next_cursor: null });
      if (req.method === 'DELETE' && p === `/stacks/${stack.id}`) {
        if (!write) return problem(403, 'API key lacks "write" scope', 'POLICY_DENIED');
        const deleteData = url.searchParams.get('delete_data') === 'true';
        return json({
          id: stack.id,
          removed: true,
          delete_data: deleteData,
          volumes_deleted: deleteData ? ['shop_data'] : [],
          volumes_kept: deleteData ? [] : ['shop_data'],
        });
      }
      let r = m(/^\/services\/([^/]+)$/);
      if (req.method === 'GET' && r) {
        const s = services.find((x) => x.id === r![1]);
        return s ? json({ ...s, last_error: s.id === 'svc_web' ? 'task: non-zero exit (137): OOMKilled' : null }) : problem(404, 'not found', 'NOT_FOUND');
      }
      r = m(/^\/services\/([^/]+)\/logs$/);
      if (req.method === 'GET' && r) {
        return json({
          data: [
            { seq: 1, stream: 'stdout', ts: 1_758_700_000_000, message: 'listening on :3000' },
            { seq: 2, stream: 'stderr', ts: 1_758_700_001_000, message: 'FATAL: JavaScript heap out of memory' },
          ],
          next_cursor: null,
        });
      }
      r = m(/^\/services\/([^/]+)\/env$/);
      if (r && req.method === 'GET') return json(env);
      if (r && req.method === 'PATCH') {
        if (!write) return problem(403, 'API key lacks "write" scope', 'POLICY_DENIED');
        const b = body as { set?: object; secrets?: object; unset?: string[] };
        return json({ id: r[1], deployment_id: r[1], changed: [...Object.keys(b.set ?? {}), ...Object.keys(b.secrets ?? {}), ...(b.unset ?? [])].sort() }, 202);
      }
      r = m(/^\/apps\/([^/]+)\/deploy$/);
      if (r && req.method === 'POST') {
        if (!write) return problem(403, 'API key lacks "write" scope', 'POLICY_DENIED');
        return json({ plan_id: 'plan_2', status: 'applied', environment: 'production', stack: 'shop', reason: null, plan: { ...plan, id: 'plan_2' } });
      }
      r = m(/^\/apps\/([^/]+)\/previews$/);
      if (r && req.method === 'POST') {
        if (!write) return problem(403, 'API key lacks "write" scope', 'POLICY_DENIED');
        return json({ action: 'deployed', stack: 'shop-pr900001', url: 'https://pr-900001.preview.acme.test', reason: null }, 202);
      }
      r = m(/^\/stacks\/([^/]+)\/telemetry$/);
      if (r && req.method === 'PUT') {
        if (!write) return problem(403, 'API key lacks "write" scope', 'POLICY_DENIED');
        return json({ stack: r[1], enabled: (body as { enabled: boolean }).enabled });
      }
      const project = { stack: 'shop', project_id: 7, dsn: 'https://k1@ctl.test/7', rate_limit_per_minute: 600, created_at: '', rotated_at: null };
      if (req.method === 'GET' && p === '/stacks/shop/errors') {
        return json({ stack: 'shop', enabled: true, store_enabled: true, project, pending_redeploy: [] });
      }
      if (req.method === 'POST' && p === '/stacks/shop/errors/rotate-key') {
        if (!write) return problem(403, 'API key lacks "write" scope', 'POLICY_DENIED');
        return json({ ...project, dsn: 'https://k2@ctl.test/7', rotated_at: 'now' });
      }
      r = m(/^\/errors\/v1\/stacks\/([^/]+)\/releases\/([^/]+)\/files$/);
      if (r && req.method === 'POST') {
        if (!write) return json({ detail: 'this API key is read-only' }, 403);
        const names = Object.keys((body as Record<string, string>) ?? {});
        return json({ stored: names.map((name) => ({ name, kind: name.endsWith('.map') ? 'sourcemap' : 'minified', debugId: null, size: 1 })) }, 201);
      }
      if (req.method === 'GET' && m(/^\/deployments\/([^/]+)$/)) {
        return json({ deployment_id: 'svc_web', service_id: 'svc_web', kind: 'deploy', phase: 'complete', desired: 2, ready: 2, message: null, started_at: '', finished_at: '' });
      }
      return problem(404, `no route ${req.method} ${p}`, 'NOT_FOUND');
    },
  };
}

/** Serve the fake over real HTTP (for subprocess tests). */
export function serveFakeApi(api: FakeApi): { url: string; stop: () => void } {
  const server = Bun.serve({ port: 0, fetch: (req) => api.fetch(req) });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
