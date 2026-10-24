import { describe, expect, it } from 'bun:test';
import type { ApiKeyScope } from '@swarmy/core';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from '../app';
import { GuardrailProblemDto } from '../dto';
import { updateServiceBodyToInput } from '../mappers';

/**
 * PATCH /services/{id} is the REST twin of tRPC `services.update`: the same
 * `updateService` (full live spec patched, admission before the swarm), the
 * same `service.configure` policy step, answered 202 + DeploymentRef.
 */

type Role = 'owner' | 'admin' | 'member';

/** Only the `:latest` rule armed at block — every other guardrail off. */
const LATEST_ONLY = [
  'noLatestTagInProd',
  'minDbReplicasProd',
  'requireBackupPolicy',
  'requireHealthcheck',
  'requireResourceLimits',
  'requireSignedImagesProd',
  'noPrivilegedContainers',
  'noHostPortsProd',
].map((id) => ({ id, enabled: id === 'noLatestTagInProd', severity: 'block' }));

const PROD_LABELS = { 'com.docker.stack.namespace': 'shop', 'swarmy.env': 'production' };

function appFor(opts: { role?: Role; scopes?: ApiKeyScope[] } = {}) {
  const role = opts.role ?? 'admin';
  const audit: string[] = [];
  const dispatched: { command: string; payload: unknown }[] = [];
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      guardrailConfig: { findUnique: async () => ({ rulesJson: LATEST_ONLY, productionSafetyMode: false }) },
      exposureConfig: { findUnique: async () => null },
      registryConfig: { findUnique: async () => null },
      backupSchedule: { count: async () => 0 },
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
      liveInventory: () => ({
        services: [
          {
            id: 'svc-api',
            name: 'shop_api',
            image: 'ghcr.io/acme/api:1.2.3',
            mode: 'replicated',
            replicas: 1,
            desiredReplicas: 1,
            runningReplicas: 1,
            labels: PROD_LABELS,
            networks: [],
            env: [],
            ports: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        containers: [],
      }),
      nodeInfoFor: () => undefined,
      isOnline: () => true,
      managerNode: () => 'node1',
      dispatch: async (_node: string, command: string, payload: unknown) => {
        dispatched.push({ command, payload });
        // updateService patches the FULL live spec — answer the inspect it reads.
        if (command === 'service.inspect') {
          return {
            inspect: {
              Spec: {
                Name: 'shop_api',
                Labels: PROD_LABELS,
                Mode: { Replicated: { Replicas: 1 } },
                TaskTemplate: {
                  ContainerSpec: { Image: 'ghcr.io/acme/api:1.2.3', Env: ['OLD=1'] },
                  RestartPolicy: { Condition: 'any' },
                },
              },
            },
          };
        }
        return {};
      },
    },
    { get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : () => { throw new Error(`unmocked hub.${k}`); }) },
  );
  const ctx = {
    db,
    hub,
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  const app = createRestApp({
    resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', scopes: opts.scopes ?? ['deploy'] } }),
  });
  return { app, audit, dispatched };
}

async function patch(t: ReturnType<typeof appFor>, id: string, body: unknown) {
  const res = await t.app.request(`/services/${id}`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const deployedSpec = (t: ReturnType<typeof appFor>) =>
  (t.dispatched.find((d) => d.command === 'service.deploy')?.payload as { spec: Record<string, unknown> } | undefined)?.spec;

describe('PATCH /services/{id}', () => {
  it('patches the live spec with the fields sent and answers 202 + DeploymentRef', async () => {
    const t = appFor();
    const r = await patch(t, 'svc-api', {
      image: 'ghcr.io/acme/api:1.2.4',
      replicas: 3,
      env: [{ key: 'LOG_LEVEL', value: 'debug' }],
      resources: { limits: { cpus: 0.5, memory_bytes: 268435456 } },
      set_labels: { tier: 'web' },
    });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ id: 'svc-api', deployment_id: 'svc-api' });
    expect(t.dispatched.map((d) => d.command)).toEqual(['service.inspect', 'service.deploy']);
    const spec = deployedSpec(t)!;
    expect(spec.image).toBe('ghcr.io/acme/api:1.2.4');
    expect(spec.mode).toEqual({ replicated: { replicas: 3 } });
    // Plain env is authoritative: OLD is gone.
    expect(spec.env).toEqual({ LOG_LEVEL: 'debug' });
    expect(spec.resources).toEqual({ limits: { cpus: 0.5, memoryBytes: 268435456 } });
    // The live label set (production) is carried; the new label is merged in.
    expect(spec.labels).toMatchObject({ ...PROD_LABELS, tier: 'web', 'swarmy.managed': 'true' });
    // Not sent → carried from the live spec.
    expect(spec.restartPolicy).toEqual({ condition: 'any' });
    // A Warn/Off guardrail that Block would have tripped leaves its receipt (admission audit).
    expect(t.audit).toEqual(['authz.permit:service.configure', 'guardrails.deploy.allowed', 'service.deploy']);
  });

  it('a guardrail refusal is a 412 listing the violations, and nothing is deployed', async () => {
    const t = appFor();
    const r = await patch(t, 'svc-api', { image: 'nginx:latest' });
    expect(r.status).toBe(412);
    expect(r.json.swarmy_code).toBe('POLICY_DENIED');
    expect(r.json.violations).toEqual([
      expect.objectContaining({ rule: 'guardrails/no-latest-tag-in-prod', severity: 'block' }),
    ]);
    expect(GuardrailProblemDto.safeParse(r.json).success).toBe(true);
    expect(t.dispatched.map((d) => d.command)).toEqual(['service.inspect']);
  });

  it('a member key is refused on a production service, like services.update', async () => {
    const t = appFor({ role: 'member' });
    const r = await patch(t, 'svc-api', { image: 'ghcr.io/acme/api:1.2.4' });
    expect(r.status).toBe(403);
    expect(r.json.swarmy_code).toBe('POLICY_DENIED');
    expect(t.audit).toEqual(['authz.deny:service.configure']);
    expect(t.dispatched).toEqual([]);
  });

  it('needs the deploy scope', async () => {
    const t = appFor({ scopes: ['read'] });
    const r = await patch(t, 'svc-api', { replicas: 2 });
    expect(r.status).toBe(403);
    expect(t.dispatched).toEqual([]);
  });

  it('an unknown service is 404', async () => {
    const t = appFor();
    const r = await patch(t, 'nope', { replicas: 2 });
    expect(r.status).toBe(404);
  });

  it('validates the body (env keys are UPPER_SNAKE_CASE)', async () => {
    const t = appFor();
    const r = await patch(t, 'svc-api', { env: [{ key: 'lower', value: 'x' }] });
    expect(r.status).toBe(400);
    expect(t.dispatched).toEqual([]);
  });
});

describe('updateServiceBodyToInput', () => {
  it('passes only the fields sent', () => {
    expect(updateServiceBodyToInput('s1', {})).toEqual({ id: 's1' });
    expect(updateServiceBodyToInput('s1', { image: 'nginx:1.27' })).toEqual({ id: 's1', image: 'nginx:1.27' });
  });

  it('maps snake_case to the services.update input', () => {
    expect(
      updateServiceBodyToInput('s1', {
        command: [],
        env: [{ key: 'A', value: '1' }, { key: 'TOKEN', value: '', secret: true, delivery: 'file' }],
        remove_secret_keys: ['OLD'],
        resources: { limits: { cpus: 1 }, reservations: {} },
        restart_policy: { condition: 'on-failure', max_attempts: 3, delay_seconds: 5 },
        update_order: 'start-first',
        set_labels: { tier: 'web' },
        remove_labels: ['legacy'],
      }),
    ).toEqual({
      id: 's1',
      command: [],
      env: [{ key: 'A', value: '1' }, { key: 'TOKEN', value: '', secret: true, delivery: 'file' }],
      removeSecretKeys: ['OLD'],
      resources: { limits: { cpus: 1 }, reservations: {} },
      restartPolicy: { condition: 'on-failure', maxAttempts: 3, delaySeconds: 5 },
      updateOrder: 'start-first',
      setLabels: { tier: 'web' },
      removeLabels: ['legacy'],
    });
  });
});
