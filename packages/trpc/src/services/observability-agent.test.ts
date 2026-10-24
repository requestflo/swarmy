import { describe, expect, it } from 'bun:test';
import { ServiceSpec } from '@swarmy/core/protocol';
import {
  AGENT_CONFIG_PREFIX,
  AGENT_SERVICE,
  agentConfig,
  agentServiceSpec,
  agentSignature,
  desiredAgent,
  planAgent,
  staleAgentConfigs,
} from './observability-agent';

describe('agentServiceSpec (one log agent per server)', () => {
  const spec = agentServiceSpec({ config: 'swarmy-otel-agent-config-deadbeef' });

  it('is the golden spec: global, read-only log mount, node-local offsets, no port, no socket', () => {
    expect(spec).toEqual({
      name: 'swarmy-otel-agent',
      image: 'otel/opentelemetry-collector-contrib:0.111.0',
      mode: { global: {} },
      labels: {
        'swarmy.managed': 'true',
        'swarmy.component': 'observability',
        'swarmy.role': 'log-agent',
        'com.docker.stack.namespace': 'swarmy-system',
        'swarmy.system': 'true',
      },
      args: ['--config', '/etc/otelcol-contrib/agent.yaml'],
      user: '0',
      env: { SWARMY_NODE: '{{.Node.Hostname}}' },
      mounts: [
        { type: 'bind', source: '/var/lib/docker/containers', target: '/var/lib/docker/containers', readOnly: true },
        { type: 'volume', source: 'swarmy-otel-agent-state', target: '/var/lib/otelcol/file_storage' },
      ],
      configs: [{ source: 'swarmy-otel-agent-config-deadbeef', target: '/etc/otelcol-contrib/agent.yaml', mode: 0o444 }],
      networks: ['swarmy'],
      resources: { limits: { cpus: 0.5, memoryBytes: 268435456 }, reservations: { memoryBytes: 67108864 } },
      updateConfig: { parallelism: 1, order: 'stop-first', failureAction: 'continue' },
      restartPolicy: { condition: 'any', delayNs: 5_000_000_000 },
    });
    expect(spec.ports).toBeUndefined();
    expect(spec.mounts?.some((m) => m.source === '/var/run/docker.sock')).toBe(false);
  });

  it('parses as a wire ServiceSpec (the deploy path sends it as-is)', () => {
    expect(ServiceSpec.safeParse(spec).success).toBe(true);
  });

  it('carries no identity labels of its own, so its output is never shipped back', () => {
    expect(spec.containerLabels).toBeUndefined();
    expect(spec.logging).toBeUndefined();
  });
});

describe('agentConfig', () => {
  it('is content-addressed and differs per org (the org is in the render)', () => {
    const a = agentConfig('org_a');
    expect(a.name).toMatch(/^swarmy-otel-agent-config-[0-9a-f]{8}$/);
    expect(agentConfig('org_a').name).toBe(a.name);
    expect(agentConfig('org_b').name).not.toBe(a.name);
    expect(a.contents).toContain('endpoint: swarmy-otel-collector:4317');
  });
});

describe('planAgent + agentSignature (signature-gated converge)', () => {
  const want = desiredAgent({ orgId: 'org_a', enabled: true })!;
  const current = { configs: [want.config.name] };

  it('nothing to want and nothing running is a no-op; collection off removes a running agent', () => {
    expect(desiredAgent({ orgId: 'org_a', enabled: false })).toBeNull();
    expect(planAgent({ desired: null })).toBe('none');
    expect(planAgent({ desired: null, live: current })).toBe('remove');
  });

  it('deploys when missing or on a stale config, and is quiet once converged', () => {
    expect(planAgent({ desired: want })).toBe('deploy');
    expect(planAgent({ desired: want, live: { configs: [`${AGENT_CONFIG_PREFIX}-00000000`] } })).toBe('deploy');
    expect(planAgent({ desired: want, live: current })).toBe('none');
  });

  it('the signature names want × have, so a steady tick repeats it exactly', () => {
    expect(agentSignature(want, undefined)).toBe(`${want.config.name}|absent`);
    expect(agentSignature(want, current)).toBe(`${want.config.name}|${want.config.name}`);
    expect(agentSignature(null, current)).toBe(`off|${want.config.name}`);
    expect(agentSignature(want, { configs: [] })).toBe(`${want.config.name}|running`);
    expect(agentSignature(want, current)).toBe(agentSignature(want, { configs: [want.config.name, 'other'] }));
  });
});

describe('staleAgentConfigs', () => {
  it('only ever sweeps our own prefix, never the kept or a referenced one', () => {
    const live = [`${AGENT_CONFIG_PREFIX}-aaaaaaaa`, `${AGENT_CONFIG_PREFIX}-bbbbbbbb`, 'swarmy-otel-collector-config-cccccccc'];
    expect(staleAgentConfigs(live, [`${AGENT_CONFIG_PREFIX}-bbbbbbbb`])).toEqual([`${AGENT_CONFIG_PREFIX}-aaaaaaaa`]);
    expect(staleAgentConfigs(live, [], [`${AGENT_CONFIG_PREFIX}-aaaaaaaa`])).toEqual([`${AGENT_CONFIG_PREFIX}-bbbbbbbb`]);
    expect(AGENT_SERVICE).toBe('swarmy-otel-agent');
  });
});
