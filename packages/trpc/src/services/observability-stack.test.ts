import { describe, expect, it } from 'bun:test';
import {
  CLICKHOUSE_NODE_LABEL,
  OBS_START_GRACE_MS,
  clickhouseServiceSpec,
  collectorServiceSpec,
  contentConfigName,
  deriveSuiteServiceStatus,
  observabilityConfigs,
  observabilityNeedsConverge,
  resolveStorePin,
  staleObservabilityConfigs,
} from './observability-stack';
import { CLICKHOUSE_INIT_PATH, COLLECTOR_CONFIG_PATH } from './observability-render';

const cfgs = observabilityConfigs({ password: 'pw', retentionDays: 7 });

describe('observability specs — Docker configs, never host binds', () => {
  it('clickhouse: init DDL is a Docker config at the entrypoint path, data on a volume, pinned', () => {
    const spec = clickhouseServiceSpec({
      password: 'pw',
      retentionDays: 7,
      initConfig: cfgs.clickhouseInit.name,
      pinSwarmNodeId: 'swarmnode123',
    });
    expect(spec.mounts).toEqual([
      { type: 'volume', source: 'swarmy-clickhouse-data', target: '/var/lib/clickhouse' },
    ]);
    expect(spec.mounts?.some((m) => m.type === 'bind')).toBe(false);
    expect(spec.configs).toEqual([
      { source: cfgs.clickhouseInit.name, target: CLICKHOUSE_INIT_PATH, mode: 0o444 },
    ]);
    expect(spec.placement).toEqual({ constraints: ['node.id==swarmnode123'] });
    expect(spec.labels?.[CLICKHOUSE_NODE_LABEL]).toBe('swarmnode123');
  });

  it('clickhouse: no pin ⇒ no constraint (never an unsatisfiable one)', () => {
    const spec = clickhouseServiceSpec({ password: 'pw', retentionDays: 7, initConfig: 'x' });
    expect(spec.placement).toBeUndefined();
    expect(spec.labels?.[CLICKHOUSE_NODE_LABEL]).toBeUndefined();
  });

  it('collector: config.yaml is a Docker config at the --config path, no mounts', () => {
    const spec = collectorServiceSpec({ clickhouseDsn: 'http://x', config: cfgs.collector.name });
    expect(spec.mounts).toBeUndefined();
    expect(spec.args).toEqual(['--config', COLLECTOR_CONFIG_PATH]);
    expect(spec.configs).toEqual([
      { source: cfgs.collector.name, target: COLLECTOR_CONFIG_PATH, mode: 0o444 },
    ]);
  });
});

describe('content-addressed config naming + rotation', () => {
  it('names are <prefix>-<sha8> and stable for the same content', () => {
    expect(cfgs.collector.name).toMatch(/^swarmy-otel-collector-config-[0-9a-f]{8}$/);
    expect(cfgs.clickhouseInit.name).toMatch(/^swarmy-clickhouse-init-[0-9a-f]{8}$/);
    expect(observabilityConfigs({ password: 'pw', retentionDays: 7 })).toEqual(cfgs);
    expect(contentConfigName('p', 'a')).toBe(contentConfigName('p', 'a'));
    expect(contentConfigName('p', 'a')).not.toBe(contentConfigName('p', 'b'));
  });

  it('a changed render (password) rolls a new collector config name', () => {
    const next = observabilityConfigs({ password: 'other', retentionDays: 7 });
    expect(next.collector.name).not.toBe(cfgs.collector.name);
    expect(next.collector.contents).toContain('other');
  });

  it('stale sweep: only our prefixes, never the kept set or foreign configs', () => {
    const keep = [cfgs.collector.name, cfgs.clickhouseInit.name];
    const existing = [
      ...keep,
      'swarmy-otel-collector-config-deadbeef',
      'swarmy-clickhouse-init-cafebabe',
      'app__v1',
      'swarmy-otel-collector-other',
    ];
    expect(staleObservabilityConfigs(existing, keep)).toEqual([
      'swarmy-otel-collector-config-deadbeef',
      'swarmy-clickhouse-init-cafebabe',
    ]);
    expect(staleObservabilityConfigs(existing, [])).toHaveLength(4);
  });
});

describe('resolveStorePin', () => {
  const known = new Set(['a', 'b']);
  it('keeps an existing pin that still names a known node', () => {
    expect(resolveStorePin({ labelled: 'b', managerSwarmNodeId: 'a', knownSwarmNodeIds: known })).toBe('b');
  });
  it('re-pins to the manager when the pinned node is gone', () => {
    expect(resolveStorePin({ labelled: 'gone', managerSwarmNodeId: 'a', knownSwarmNodeIds: known })).toBe('a');
  });
  it('first deploy pins to the manager; unresolvable ⇒ undefined', () => {
    expect(resolveStorePin({ managerSwarmNodeId: 'a', knownSwarmNodeIds: known })).toBe('a');
    expect(resolveStorePin({ knownSwarmNodeIds: known })).toBeUndefined();
  });
});

describe('observabilityNeedsConverge', () => {
  const store = { configs: [cfgs.clickhouseInit.name], mounts: [{ type: 'volume', target: '/d' }], labels: { [CLICKHOUSE_NODE_LABEL]: 'a' } };
  const collector = { configs: [cfgs.collector.name], mounts: [], labels: {} };
  it('converged suite is a no-op', () => {
    expect(observabilityNeedsConverge({ store, collector, desired: cfgs, desiredPin: 'a' })).toBe(false);
  });
  it('legacy bind-mount specs converge', () => {
    const legacy = {
      configs: [],
      mounts: [{ type: 'bind', source: '/etc/swarmy/observability/collector/config.yaml', target: COLLECTOR_CONFIG_PATH }],
      labels: {},
    };
    expect(observabilityNeedsConverge({ store, collector: legacy, desired: cfgs, desiredPin: 'a' })).toBe(true);
  });
  it('missing service, stale config, or moved pin converge', () => {
    expect(observabilityNeedsConverge({ collector, desired: cfgs })).toBe(true);
    expect(
      observabilityNeedsConverge({ store, collector: { ...collector, configs: ['swarmy-otel-collector-config-old'] }, desired: cfgs, desiredPin: 'a' }),
    ).toBe(true);
    expect(observabilityNeedsConverge({ store, collector, desired: cfgs, desiredPin: 'b' })).toBe(true);
    expect(
      observabilityNeedsConverge({ store: { ...store, labels: {} }, collector, desired: cfgs, desiredPin: 'a' }),
    ).toBe(true);
  });
});

describe('deriveSuiteServiceStatus — live tasks, not what was requested', () => {
  const now = 10_000_000;
  it('disabled ⇒ OFFLINE', () => {
    expect(deriveSuiteServiceStatus({ enabled: false, now, service: { runningReplicas: 1, updatedAt: now } })).toBe('OFFLINE');
  });
  it('running tasks ⇒ RUNNING (even after an earlier dispatch failure)', () => {
    expect(deriveSuiteServiceStatus({ enabled: true, now, deployFailed: true, service: { runningReplicas: 1, updatedAt: 0 } })).toBe('RUNNING');
  });
  it('0 tasks inside the start grace ⇒ DEPLOYING', () => {
    expect(deriveSuiteServiceStatus({ enabled: true, now, service: { runningReplicas: 0, updatedAt: now - 1000 } })).toBe('DEPLOYING');
    expect(deriveSuiteServiceStatus({ enabled: true, now, requestedAt: now - 1000 })).toBe('DEPLOYING');
  });
  it('0 tasks past the grace (rejected forever) ⇒ FAILED, never RUNNING', () => {
    expect(
      deriveSuiteServiceStatus({ enabled: true, now, service: { runningReplicas: 0, updatedAt: now - OBS_START_GRACE_MS - 1 } }),
    ).toBe('FAILED');
    expect(deriveSuiteServiceStatus({ enabled: true, now, requestedAt: now - OBS_START_GRACE_MS - 1 })).toBe('FAILED');
  });
  it('a failed dispatch with no running task ⇒ FAILED', () => {
    expect(deriveSuiteServiceStatus({ enabled: true, now, deployFailed: true, requestedAt: now })).toBe('FAILED');
  });
});
