import { describe, expect, it } from 'bun:test';
import { ServiceModel } from './compose/model';
import { modelToServiceSpec } from './compose/to-spec';
import {
  boundedLogConfig,
  carryLogDriver,
  DEFAULT_LOG_DRIVER,
  logDriverFor,
  toServiceCreateOptions,
} from './docker';

type Opts = { TaskTemplate: { LogDriver?: { Name: string; Options: Record<string, string> } } };

describe('bounded container logs (disk hygiene: nodes must never fill up)', () => {
  it('every deployed service gets json-file 10m × 3 unless the spec says otherwise', () => {
    expect(DEFAULT_LOG_DRIVER).toEqual({ Name: 'json-file', Options: { 'max-size': '10m', 'max-file': '3' } });
    const opts = toServiceCreateOptions({ name: 'web', image: 'nginx' }) as unknown as Opts;
    expect(opts.TaskTemplate.LogDriver).toEqual({ Name: 'json-file', Options: { 'max-size': '10m', 'max-file': '3' } });
  });

  it('a spec logging override wins', () => {
    expect(logDriverFor({ logging: { driver: 'local' } })).toEqual({ Name: 'local', Options: {} });
    const opts = toServiceCreateOptions({
      name: 'web',
      image: 'nginx',
      logging: { driver: 'loki', options: { 'loki-url': 'http://loki:3100' } },
    }) as unknown as Opts;
    expect(opts.TaskTemplate.LogDriver).toEqual({ Name: 'loki', Options: { 'loki-url': 'http://loki:3100' } });
  });

  it('an update without logging carries the live driver; a live service with none gets the default', () => {
    const fresh = () => toServiceCreateOptions({ name: 'web', image: 'nginx' }) as unknown as Opts;
    const carried = carryLogDriver(fresh(), {}, { Name: 'fluentd', Options: { tag: 'x' } }) as Opts;
    expect(carried.TaskTemplate.LogDriver).toEqual({ Name: 'fluentd', Options: { tag: 'x' } });
    const none = carryLogDriver(fresh(), {}, undefined) as Opts;
    expect(none.TaskTemplate.LogDriver).toEqual(logDriverFor({}));
    // An explicit spec is authoritative over the live driver.
    const explicit = toServiceCreateOptions({ name: 'w', image: 'n', logging: { driver: 'local' } }) as unknown as Opts;
    expect((carryLogDriver(explicit, { logging: { driver: 'local' } }, { Name: 'fluentd' }) as Opts).TaskTemplate.LogDriver)
      .toEqual({ Name: 'local', Options: {} });
  });

  it('re-created plain containers keep a chosen driver but never an unbounded json-file', () => {
    expect(boundedLogConfig(undefined)).toEqual({ Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } });
    expect(boundedLogConfig({ Type: 'json-file', Config: {} })).toEqual(boundedLogConfig(undefined));
    expect(boundedLogConfig({ Type: 'json-file', Config: { 'max-size': '50m' } })).toEqual({
      Type: 'json-file',
      Config: { 'max-size': '50m' },
    });
    expect(boundedLogConfig({ Type: 'journald', Config: {} })).toEqual({ Type: 'journald', Config: {} });
  });

  it('compose `logging` flows through to the spec', () => {
    const svc = (logging?: unknown) =>
      modelToServiceSpec(ServiceModel.parse({ name: 'web', image: 'nginx', ...(logging ? { logging } : {}) }));
    expect(svc({ driver: 'local', options: { 'max-size': '20m' } }).logging).toEqual({
      driver: 'local',
      options: { 'max-size': '20m' },
    });
    // Options without a driver tune the bounded json-file default.
    expect(svc({ options: { 'max-file': '5' } }).logging).toEqual({ driver: 'json-file', options: { 'max-file': '5' } });
    expect(svc().logging).toBeUndefined();
  });
});
