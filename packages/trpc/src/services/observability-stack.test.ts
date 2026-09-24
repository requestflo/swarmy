import { describe, expect, it } from 'bun:test';
import {
  CLICKHOUSE_NODE_LABEL,
  CLICKHOUSE_PASSWORD_FILE,
  OBS_START_GRACE_MS,
  clickhouseServiceSpec,
  collectorServiceSpec,
  contentConfigName,
  deriveSuiteServiceStatus,
  observabilityConfigs,
  observabilityNeedsConverge,
  resolveStorePin,
  staleObservabilityConfigs,
  staleObservabilitySecrets,
} from './observability-stack';
import { CLICKHOUSE_INIT_PATH, COLLECTOR_CONFIG_PATH } from './observability-render';

const PASSWORD = 'Zx9-super_secret-Pw42';
const cfgs = observabilityConfigs({ password: PASSWORD, retentionDays: 7 });

describe('observability specs — Docker configs, never host binds', () => {
  it('clickhouse: init DDL is a Docker config at the entrypoint path, data on a volume, pinned', () => {
    const spec = clickhouseServiceSpec({
      passwordSecret: cfgs.clickhousePassword.name,
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
    const spec = clickhouseServiceSpec({ passwordSecret: 's', retentionDays: 7, initConfig: 'x' });
    expect(spec.placement).toBeUndefined();
    expect(spec.labels?.[CLICKHOUSE_NODE_LABEL]).toBeUndefined();
  });

  it('collector: config.yaml is a Docker config at the --config path, no mounts', () => {
    const spec = collectorServiceSpec({ passwordSecret: cfgs.clickhousePassword.name, config: cfgs.collector.name });
    expect(spec.mounts).toBeUndefined();
    expect(spec.args).toEqual(['--config', COLLECTOR_CONFIG_PATH]);
    expect(spec.configs).toEqual([
      { source: cfgs.collector.name, target: COLLECTOR_CONFIG_PATH, mode: 0o444 },
    ]);
  });
});

describe('the ClickHouse password is a Docker SECRET — never in a config or env', () => {
  const store = clickhouseServiceSpec({ passwordSecret: cfgs.clickhousePassword.name, retentionDays: 7, initConfig: cfgs.clickhouseInit.name });
  const collector = collectorServiceSpec({ passwordSecret: cfgs.clickhousePassword.name, config: cfgs.collector.name });

  it('rendered configs contain NO secret material', () => {
    expect(cfgs.collector.contents).not.toContain(PASSWORD);
    expect(cfgs.clickhouseInit.contents).not.toContain(PASSWORD);
    expect(cfgs.collector.contents).toContain(`password: \${file:${CLICKHOUSE_PASSWORD_FILE}}`);
  });

  it('specs carry no plaintext password (env/labels/args) and both mount the secret', () => {
    for (const spec of [store, collector]) {
      expect(JSON.stringify(spec)).not.toContain(PASSWORD);
      expect(spec.secrets).toEqual([
        { source: cfgs.clickhousePassword.name, target: 'clickhouse-password', mode: 0o444 },
      ]);
    }
    expect(store.env?.CLICKHOUSE_PASSWORD).toBeUndefined();
    expect(store.env?.CLICKHOUSE_PASSWORD_FILE).toBe(CLICKHOUSE_PASSWORD_FILE);
    expect(collector.env?.CLICKHOUSE_ENDPOINT).not.toContain('@');
  });

  it('the secret is content-addressed (rotation ⇒ new name) and holds the password', () => {
    expect(cfgs.clickhousePassword.name).toMatch(/^swarmy-clickhouse-password-[0-9a-f]{8}$/);
    expect(cfgs.clickhousePassword.value).toBe(PASSWORD);
    const rotated = observabilityConfigs({ password: 'other', retentionDays: 7 });
    expect(rotated.clickhousePassword.name).not.toBe(cfgs.clickhousePassword.name);
    // The config references the stable secret PATH, so it does not change on rotation.
    expect(rotated.collector.name).toBe(cfgs.collector.name);
  });

  it('stale secret sweep: only our prefix, never kept/referenced or foreign secrets', () => {
    const keep = [cfgs.clickhousePassword.name];
    const existing = [...keep, 'swarmy-clickhouse-password-deadbeef', 'swarmy-cache-x-password', 'app_pw'];
    expect(staleObservabilitySecrets(existing, keep)).toEqual(['swarmy-clickhouse-password-deadbeef']);
    expect(staleObservabilitySecrets(existing, [], ['swarmy-clickhouse-password-deadbeef'])).toEqual(keep);
  });
});

describe('content-addressed config naming + rotation', () => {
  it('names are <prefix>-<sha8> and stable for the same content', () => {
    expect(cfgs.collector.name).toMatch(/^swarmy-otel-collector-config-[0-9a-f]{8}$/);
    expect(cfgs.clickhouseInit.name).toMatch(/^swarmy-clickhouse-init-[0-9a-f]{8}$/);
    expect(observabilityConfigs({ password: PASSWORD, retentionDays: 7 })).toEqual(cfgs);
    expect(contentConfigName('p', 'a')).toBe(contentConfigName('p', 'a'));
    expect(contentConfigName('p', 'a')).not.toBe(contentConfigName('p', 'b'));
  });

  it('a changed render (retention) rolls a new collector config name', () => {
    const next = observabilityConfigs({ password: PASSWORD, retentionDays: 30 });
    expect(next.collector.name).not.toBe(cfgs.collector.name);
    expect(next.collector.contents).toContain('ttl: 720h');
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
  const sec = [cfgs.clickhousePassword.name];
  const store = {
    configs: [cfgs.clickhouseInit.name],
    mounts: [{ type: 'volume', target: '/d' }],
    labels: { [CLICKHOUSE_NODE_LABEL]: 'a' },
    secrets: sec,
    env: ['CLICKHOUSE_USER=default', `CLICKHOUSE_PASSWORD_FILE=${CLICKHOUSE_PASSWORD_FILE}`],
  };
  const collector = { configs: [cfgs.collector.name], mounts: [], labels: {}, secrets: sec, env: ['CLICKHOUSE_ENDPOINT=tcp://swarmy-clickhouse:9000'] };
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

describe('observabilityNeedsConverge — secret embedded in config/env migrates', () => {
  const sec = [cfgs.clickhousePassword.name];
  const store = { configs: [cfgs.clickhouseInit.name], mounts: [], labels: { [CLICKHOUSE_NODE_LABEL]: 'a' } as Record<string, string>, secrets: sec, env: [] as string[] };
  const collector = { ...store, configs: [cfgs.collector.name], labels: {} as Record<string, string> };
  const run = (s: typeof store, c: typeof collector) =>
    observabilityNeedsConverge({ store: s, collector: c, desired: cfgs, desiredPin: 'a' });

  it('a legacy install (password inside the collector config, no secret mounted) converges', () => {
    const legacyCfg = { ...collector, configs: ['swarmy-otel-collector-config-0ld0ld00'], secrets: [] };
    expect(run(store, legacyCfg)).toBe(true);
  });
  it('either service not mounting the current password secret converges', () => {
    expect(run({ ...store, secrets: [] }, collector)).toBe(true);
    expect(run(store, { ...collector, secrets: ['swarmy-clickhouse-password-deadbeef'] })).toBe(true);
  });
  it('plaintext password env (store) or credentialed DSN env (collector) converges', () => {
    expect(run({ ...store, env: ['CLICKHOUSE_PASSWORD=hunter2'] }, collector)).toBe(true);
    expect(run(store, { ...collector, env: ['CLICKHOUSE_ENDPOINT=http://default:hunter2@swarmy-clickhouse:8123/otel'] })).toBe(true);
    expect(run(store, collector)).toBe(false);
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

describe('network placement — ClickHouse is control-plane only', () => {
  const base = { passwordSecret: 's', retentionDays: 7, initConfig: 'i' };
  it('store on swarmy-control ONLY, no published ports; collector bridges swarmy ↔ swarmy-control', () => {
    const ch = clickhouseServiceSpec(base);
    expect(ch.networks).toEqual(['swarmy-control']);
    expect(ch.ports ?? []).toEqual([]);
    const col = collectorServiceSpec({ passwordSecret: 's', config: 'c' });
    expect(col.networks).toEqual(['swarmy', 'swarmy-control']);
    expect(col.ports ?? []).toEqual([]);
  });
  it('keeps the store on swarmy only while the controller has not moved yet (migration bridge)', () => {
    expect(clickhouseServiceSpec({ ...base, controllerOnSharedOnly: true }).networks).toEqual(['swarmy-control', 'swarmy']);
  });
});
