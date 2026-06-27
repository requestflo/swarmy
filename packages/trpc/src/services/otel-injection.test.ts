import { describe, expect, it } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import {
  augmentSpecForService,
  augmentSpecsForStack,
  injectOtel,
  resolveServiceTelemetry,
} from './otel-injection';

const SPEC: ServiceSpec = { name: 'api', image: 'app:1' };

describe('injectOtel', () => {
  it('injects OTEL_* env, labels and the overlay network without mutating input', () => {
    const out = injectOtel(SPEC, { orgId: 'org1', stack: 'shop' });
    expect(out.env?.OTEL_SERVICE_NAME).toBe('api');
    expect(out.env?.OTEL_RESOURCE_ATTRIBUTES).toContain('swarmy.org_id=org1');
    expect(out.env?.OTEL_RESOURCE_ATTRIBUTES).toContain('swarmy.stack=shop');
    expect(out.labels?.['swarmy.telemetry']).toBe('on');
    expect(out.networks).toContain('swarmy');
    // input untouched
    expect(SPEC.env).toBeUndefined();
    expect(SPEC.networks).toBeUndefined();
  });

  it('never overwrites a user-set OTEL_* var', () => {
    const userSpec: ServiceSpec = {
      ...SPEC,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://my-own-collector:4317' },
    };
    const out = injectOtel(userSpec, { orgId: 'org1', stack: 'shop' });
    expect(out.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://my-own-collector:4317');
  });
});

describe('resolveServiceTelemetry', () => {
  it('service override true forces on even if the stack is off', () => {
    expect(resolveServiceTelemetry({ stackEnabled: false, serviceOverride: true })).toBe(true);
  });
  it('service override false forces off even if the stack is on', () => {
    expect(resolveServiceTelemetry({ stackEnabled: true, serviceOverride: false })).toBe(false);
  });
  it('falls back to the stack flag when no override', () => {
    expect(resolveServiceTelemetry({ stackEnabled: true })).toBe(true);
    expect(resolveServiceTelemetry({ stackEnabled: false })).toBe(false);
    expect(resolveServiceTelemetry({ stackEnabled: true, serviceOverride: null })).toBe(true);
  });
});

describe('augmentSpecForService', () => {
  it('injects when the resolved state is on', () => {
    const out = augmentSpecForService(SPEC, {
      stackEnabled: false,
      serviceOverride: true,
      orgId: 'org1',
      stack: 'shop',
    });
    expect(out.env?.OTEL_SERVICE_NAME).toBe('api');
  });

  it('is a strict no-op (same reference) when the resolved state is off', () => {
    const out = augmentSpecForService(SPEC, {
      stackEnabled: true,
      serviceOverride: false,
      orgId: 'org1',
      stack: 'shop',
    });
    expect(out).toBe(SPEC);
  });
});

describe('augmentSpecsForStack', () => {
  it('passes specs through untouched when telemetry is disabled', () => {
    const specs = [SPEC];
    expect(augmentSpecsForStack(specs, { telemetryEnabled: false, orgId: 'o', stack: 's' })).toBe(
      specs,
    );
  });
  it('injects every spec when enabled', () => {
    const out = augmentSpecsForStack([SPEC], { telemetryEnabled: true, orgId: 'o', stack: 's' });
    expect(out[0]!.env?.OTEL_SERVICE_NAME).toBe('api');
  });
});
