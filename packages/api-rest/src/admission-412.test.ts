import { describe, expect, it } from 'bun:test';
import { seedKv, useMemoryKv, type OrgContext } from '@swarmy/trpc';
import { buildOpenApiDocument, createRestApp } from './app';
import { GuardrailProblemDto } from './dto';
import { trpcErrorToProblem } from './problem';

/**
 * auth-abac invariant 9: deploy-shaped mutations pass the admission pipeline
 * before the swarm, and a refusal is `412` (PRECONDITION_FAILED,
 * `POLICY_DENIED`). Over REST that 412 is problem+json carrying every
 * violation, and every route that runs admission documents it.
 */

/** The routes whose service runs `enforceAdmission` (createService / deployFromCompose / updateService). */
const ADMISSION_ROUTES = ['post /services', 'post /stacks', 'patch /services/{id}/env'];

function appFor(audit: string[]) {
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role: 'admin', organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      auditLog: {
        create: async ({ data }: { data: { action: string } }) => {
          audit.push(data.action);
          return {};
        },
      },
    } as Record<string, unknown>,
    {
      get: (t, k: string) =>
        k in t ? t[k] : new Proxy({}, { get: () => async () => { throw new Error(`unmocked db.${k}`); } }),
    },
  );
  const hub = new Proxy(
    {
      liveInventory: () => ({ services: [], containers: [] }),
      nodeInfoFor: () => undefined,
      managerNode: () => 'mgr1',
      isOnline: () => true,
    },
    { get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : () => { throw new Error(`unmocked hub.${k}`); }) },
  );
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org1', 'stack', 'st-shop', { name: 'shop', composeSource: '', ingressDriver: null });
  const ctx = {
    db,
    hub,
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role: 'admin', orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({ resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', scopes: ['write'] } }) });
}

async function post(path: string, body: unknown) {
  const audit: string[] = [];
  const res = await appFor(audit).request(path, {
    method: 'POST',
    headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, type: res.headers.get('content-type'), json: (await res.json()) as Record<string, unknown>, audit };
}

describe('an admission refusal is a 412 problem+json listing the violations', () => {
  it('POST /services — a reserved platform name never reaches the swarm', async () => {
    const r = await post('/services', { name: 'swarmy-evil', image: 'nginx:1.27' });
    expect(r.status).toBe(412);
    expect(r.type).toContain('application/problem+json');
    expect(r.json.swarmy_code).toBe('POLICY_DENIED');
    expect(r.json.violations).toEqual([
      {
        rule: 'platform.reserved-name',
        severity: 'block',
        message: "service names starting with `swarmy-` / `swarmy_` are reserved for swarmy's own platform services",
        resource: 'swarmy-evil',
      },
    ]);
    expect(GuardrailProblemDto.safeParse(r.json).success).toBe(true);
  });

  it('POST /stacks — an app posing as a platform service', async () => {
    const compose = 'services:\n  web:\n    image: nginx:1.27\n    labels: ["swarmy.system=true"]\n';
    const r = await post('/stacks', { name: 'shop', compose_source: compose });
    expect(r.status).toBe(412);
    expect(r.json.swarmy_code).toBe('POLICY_DENIED');
    expect(r.json.violations).toEqual([
      expect.objectContaining({ rule: 'label.system', severity: 'block', resource: 'shop_web' }),
    ]);
    expect(GuardrailProblemDto.safeParse(r.json).success).toBe(true);
  });
});

describe('trpcErrorToProblem carries only the public fields of each violation', () => {
  const refusal = (violations: unknown) => ({
    name: 'TRPCError',
    code: 'PRECONDITION_FAILED',
    message: 'Deployment blocked by policy',
    cause: { swarmyCode: 'POLICY_DENIED', violations },
  });

  it('maps rule/severity/message/resource and drops anything else', () => {
    const p = trpcErrorToProblem(
      refusal([
        { rule: 'no-latest-tag-in-prod', severity: 'warn', message: 'pin a tag', resource: 'shop_web', internal: 1 },
        { rule: 'host-ports-prod', severity: 'block', message: 'no host ports' },
        { nonsense: true },
      ]),
      '/api/v1/services',
    );
    expect(p).toEqual({
      type: 'https://swarmy.dev/problems/precondition_failed',
      title: 'Precondition Failed',
      status: 412,
      detail: 'Deployment blocked by policy',
      instance: '/api/v1/services',
      swarmy_code: 'POLICY_DENIED',
      violations: [
        { rule: 'no-latest-tag-in-prod', severity: 'warn', message: 'pin a tag', resource: 'shop_web' },
        { rule: 'host-ports-prod', severity: 'block', message: 'no host ports' },
      ],
    });
  });

  it('other problems keep their shape (no `violations` key)', () => {
    const p = trpcErrorToProblem({ name: 'TRPCError', code: 'PRECONDITION_FAILED', message: 'no online manager node', cause: { swarmyCode: 'NO_MANAGER' } });
    expect('violations' in p).toBe(false);
  });
});

describe('the spec documents the 412 on every route that runs admission', () => {
  const doc = buildOpenApiDocument({ resolveContextFromApiKey: async () => null }) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: { $ref?: string } }> }> }>>;
  };
  for (const route of ADMISSION_ROUTES) {
    it(route, () => {
      const [method, path] = route.split(' ') as [string, string];
      const res = doc.paths[path]![method]!.responses['412'];
      expect(res?.content?.['application/problem+json']?.schema.$ref).toBe('#/components/schemas/GuardrailProblem');
    });
  }
});
