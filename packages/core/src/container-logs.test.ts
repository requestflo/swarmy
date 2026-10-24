import { describe, expect, it } from 'bun:test';
import {
  augmentSpecsForContainerLogs,
  carryContainerLabels,
  containerLogsOn,
  jsonFileOptionsWithIdentity,
  withLogIdentity,
} from './container-logs';
import { toServiceCreateOptions } from './docker';
import { ObservabilityLogsInput, TelemetrySettings } from './inputs';
import { ServiceSpec } from './protocol';
import { defaultTelemetrySettings } from './telemetry';

const SPEC: ServiceSpec = { name: 'shop_web', image: 'nginx:1.27' };

describe('json-file options keep the rotation bound the agent depends on', () => {
  it('adds the identity labels to swarmy’s bounded default', () => {
    expect(jsonFileOptionsWithIdentity(undefined)).toEqual({
      'max-size': '10m',
      'max-file': '3',
      labels: 'swarmy.stack,swarmy.service',
    });
  });

  it('merges with labels already listed and keeps bigger limits', () => {
    expect(jsonFileOptionsWithIdentity({ 'max-size': '50m', 'max-file': '5', labels: 'team,swarmy.stack' })).toEqual({
      'max-size': '50m',
      'max-file': '5',
      labels: 'team,swarmy.stack,swarmy.service',
    });
  });

  it('floors max-file at 2 whenever the file rotates (1 would truncate in place)', () => {
    expect(jsonFileOptionsWithIdentity({ 'max-size': '20m', 'max-file': '1' })['max-file']).toBe('2');
    // Docker's default max-file is 1 once max-size is set.
    expect(jsonFileOptionsWithIdentity({ 'max-size': '20m' })['max-file']).toBe('2');
    // No max-size = no rotation: nothing to protect, nothing added.
    expect(jsonFileOptionsWithIdentity({ compress: 'false' })['max-file']).toBeUndefined();
  });
});

describe('withLogIdentity', () => {
  it('stamps the container labels and the json-file labels option', () => {
    const out = withLogIdentity(SPEC, { stack: 'shop' });
    expect(out.containerLabels).toEqual({ 'swarmy.stack': 'shop', 'swarmy.service': 'shop_web' });
    expect(out.logging).toEqual({
      driver: 'json-file',
      options: { 'max-size': '10m', 'max-file': '3', labels: 'swarmy.stack,swarmy.service' },
    });
    expect(SPEC.containerLabels).toBeUndefined(); // never mutates
  });

  it('leaves another driver and an opted-out service untouched (identity)', () => {
    const loki: ServiceSpec = { ...SPEC, logging: { driver: 'loki', options: { 'loki-url': 'http://l' } } };
    expect(withLogIdentity(loki, { stack: 'shop' })).toBe(loki);
    const off: ServiceSpec = { ...SPEC, labels: { 'swarmy.logs.stdout': 'off' } };
    expect(withLogIdentity(off, { stack: 'shop' })).toBe(off);
  });

  it('is a no-op array identity when the org does not collect', () => {
    const specs = [SPEC];
    expect(augmentSpecsForContainerLogs(specs, { enabled: false, stack: 'shop' })).toBe(specs);
    expect(augmentSpecsForContainerLogs(specs, { enabled: true, stack: 'shop' })[0]!.containerLabels?.['swarmy.stack']).toBe('shop');
  });

  it('reaches Docker as ContainerSpec.Labels + the LogDriver option', () => {
    const opts = toServiceCreateOptions(withLogIdentity(SPEC, { stack: 'shop' })) as unknown as {
      TaskTemplate: { ContainerSpec: { Labels?: Record<string, string> }; LogDriver: { Options: Record<string, string> } };
    };
    expect(opts.TaskTemplate.ContainerSpec.Labels).toEqual({ 'swarmy.stack': 'shop', 'swarmy.service': 'shop_web' });
    expect(opts.TaskTemplate.LogDriver.Options.labels).toBe('swarmy.stack,swarmy.service');
    const plain = toServiceCreateOptions(SPEC) as unknown as { TaskTemplate: { ContainerSpec: Record<string, unknown> } };
    expect('Labels' in plain.TaskTemplate.ContainerSpec).toBe(false);
    expect('User' in plain.TaskTemplate.ContainerSpec).toBe(false);
  });
});

describe('carryContainerLabels (update path)', () => {
  const live = { 'swarmy.stack': 'shop', 'swarmy.service': 'shop_web' };
  it('keeps the live labels when the spec does not carry any', () => {
    const opts = { TaskTemplate: { ContainerSpec: {} as { Labels?: Record<string, string> } } };
    expect(carryContainerLabels(opts, {}, live).TaskTemplate!.ContainerSpec!.Labels).toEqual(live);
  });
  it('a spec that carries labels is authoritative', () => {
    const opts = { TaskTemplate: { ContainerSpec: { Labels: { a: 'b' } } } };
    expect(carryContainerLabels(opts, { containerLabels: { a: 'b' } }, live).TaskTemplate!.ContainerSpec!.Labels).toEqual({ a: 'b' });
  });
});

describe('settings + wire stay additive', () => {
  it('saved telemetry settings without containerLogs still parse, and read as off', () => {
    const saved = defaultTelemetrySettings(7);
    expect(TelemetrySettings.safeParse(saved).success).toBe(true);
    expect(containerLogsOn(saved)).toBe(false);
    expect(containerLogsOn({ ...saved, containerLogs: { enabled: true } })).toBe(true);
    expect(TelemetrySettings.safeParse({ ...saved, containerLogs: { enabled: 'yes' } }).success).toBe(false);
  });

  it('ServiceSpec round-trips containerLabels + user, and rejects a bad shape', () => {
    const ok = ServiceSpec.safeParse({ ...SPEC, containerLabels: { 'swarmy.stack': 'shop' }, user: '0' });
    expect(ok.success && ok.data.containerLabels?.['swarmy.stack']).toBe('shop');
    expect(ok.success && ok.data.user).toBe('0');
    expect(ServiceSpec.safeParse({ ...SPEC, containerLabels: { a: 1 } }).success).toBe(false);
    expect(ServiceSpec.safeParse({ ...SPEC, user: '' }).success).toBe(false);
  });

  it('the logs input takes a source filter', () => {
    expect(ObservabilityLogsInput.safeParse({ from: 0, to: 1, source: 'stdout' }).success).toBe(true);
    expect(ObservabilityLogsInput.safeParse({ from: 0, to: 1, source: 'syslog' }).success).toBe(false);
  });
});
