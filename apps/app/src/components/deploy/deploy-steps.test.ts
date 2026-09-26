import { describe, expect, test } from 'bun:test';
import type { BlueprintDeployResultView, InvService } from '@swarmy/core';
import { deriveDeploy, type DeployDomain } from './deploy-steps';

function svc(name: string, running: number, opts: Partial<InvService> = {}): InvService {
  const desired = opts.replicas?.desired ?? 1;
  return {
    id: `id-${name}`,
    name,
    image: `${name}:1`,
    stack: 'blog',
    mode: 'replicated',
    replicas: { desired, running },
    status: running >= desired ? 'running' : 'deploying',
    scaleToZero: false,
    labels: {},
    networks: [],
    env: [],
    ports: name === 'wordpress' ? [{ target: 80, protocol: 'tcp' }] : [],
    containers: [],
    ...opts,
  };
}

const route = (state: string | null, serving = true): DeployDomain => ({
  id: 'd1',
  host: 'blog.example.com',
  serviceId: 'id-wordpress',
  serviceName: 'wordpress',
  tls: 'auto',
  serving,
  status: state
    ? { state, reason: '', certificate: state === 'active' ? { issuer: "Let's Encrypt", expiresAt: null, error: null } : null }
    : null,
});

const states = (p: ReturnType<typeof deriveDeploy>) => p.steps.map((s) => s.state);

describe('deriveDeploy', () => {
  test('nothing in the inventory yet: every step waits, never live', () => {
    const p = deriveDeploy({ stack: 'blog', result: null, services: [], domains: [] });
    expect(states(p)).toEqual(['waiting', 'skipped', 'waiting', 'skipped', 'waiting']);
    expect(p.live).toBe(false);
    expect(p.current).toBe(1);
  });

  test('a service with no container is pulling; one with a container has its image', () => {
    const pulling = deriveDeploy({ stack: 'blog', result: null, services: [svc('wordpress', 0)], domains: [route('issuing')] });
    expect(pulling.steps[0]!.state).toBe('working');
    const starting = deriveDeploy({
      stack: 'blog',
      result: null,
      services: [svc('wordpress', 0, { containers: [{ id: 'c', name: 'c', image: 'x', state: 'starting' }] })],
      domains: [route('issuing')],
    });
    expect(starting.steps[0]!.state).toBe('done');
    expect(starting.steps[2]!.state).toBe('working');
    expect(starting.steps[3]!.state).toBe('working');
    expect(starting.current).toBe(3);
  });

  test('the routed service is the main one; its companions are its data', () => {
    const p = deriveDeploy({ stack: 'blog', result: null, services: [svc('db', 1), svc('wordpress', 0)], domains: [route(null)] });
    expect(p.primary?.name).toBe('wordpress');
    expect(p.steps[1]!.state).toBe('done');
    expect(p.steps[2]!.title).toBe('Start wordpress');
  });

  test('live once every part runs and the certificate is in', () => {
    const p = deriveDeploy({ stack: 'blog', result: null, services: [svc('db', 1), svc('wordpress', 1)], domains: [route('active')] });
    expect(states(p)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(p.live).toBe(true);
  });

  test('not live while the address waits for DNS, even with every part up', () => {
    const p = deriveDeploy({ stack: 'blog', result: null, services: [svc('wordpress', 1)], domains: [route('waiting_dns')] });
    expect(p.steps[3]!.state).toBe('needs');
    expect(p.live).toBe(false);
  });

  test('a failed blueprint step shows as failed', () => {
    const result: BlueprintDeployResultView = {
      id: 'wordpress',
      stackName: 'blog',
      ok: false,
      url: null,
      notes: [],
      steps: [
        { kind: 'stack.deploy', label: 'Deploy', status: 'succeeded', detail: null, error: null },
        { kind: 'ingress.route', label: 'Route', status: 'failed', detail: null, error: 'host taken' },
      ],
    };
    const p = deriveDeploy({ stack: 'blog', result, services: [svc('wordpress', 1)], domains: [] });
    expect(p.failed?.key).toBe('https');
  });
});
