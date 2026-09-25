import { describe, expect, it } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { SPEC_SIGNATURE_LABEL, deploySignature, gateSystemDeploy, isSystemOwned } from './system-service-deploy';

/** The no-op-update guard for every system-service converge. */
const collector: ServiceSpec = { name: 'swarmy-otel-collector', image: 'otel/opentelemetry-collector-contrib@sha256:aa', labels: { 'swarmy.system': 'true' } };

describe('gateSystemDeploy', () => {
  it('system-owned: platform label, swarmy-* names, managed-data labels; never user apps', () => {
    expect(isSystemOwned(collector)).toBe(true);
    expect(isSystemOwned({ name: 'swarmy-garage', labels: {} })).toBe(true);
    expect(isSystemOwned({ name: 'shop_db-primary', labels: { 'swarmy.db.cluster': 'db' } })).toBe(true);
    expect(isSystemOwned({ name: 'shop_web', labels: { 'swarmy.managed': 'true', 'com.docker.stack.namespace': 'shop' } })).toBe(false);
  });

  it('stamps the signature; an unchanged desired spec on a live service is skipped', () => {
    const first = gateSystemDeploy({ spec: collector, pullPolicy: 'missing' }, undefined);
    expect(first.skip).toBe(false);
    const sig = first.payload.spec.labels![SPEC_SIGNATURE_LABEL]!;
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
    expect(gateSystemDeploy({ spec: collector, pullPolicy: 'missing' }, { labels: { [SPEC_SIGNATURE_LABEL]: sig } }).skip).toBe(true);
    // A real change deploys.
    expect(gateSystemDeploy({ spec: { ...collector, env: { A: '1' } } }, { labels: { [SPEC_SIGNATURE_LABEL]: sig } }).skip).toBe(false);
  });

  it('rotated pull credentials change the signature (the service must be re-stamped)', () => {
    const a = deploySignature(collector as never, { username: 'swarmy', password: 'one', server: 'localhost:5000' });
    const b = deploySignature(collector as never, { username: 'swarmy', password: 'two', server: 'localhost:5000' });
    expect(a).not.toBe(b);
  });

  it('pullPolicy always on a floating tag always deploys; on a pinned digest it may skip', () => {
    const floating = { ...collector, image: 'otel/opentelemetry-collector-contrib:latest' };
    const sigF = gateSystemDeploy({ spec: floating }, undefined).payload.spec.labels![SPEC_SIGNATURE_LABEL]!;
    expect(gateSystemDeploy({ spec: floating, pullPolicy: 'always' }, { labels: { [SPEC_SIGNATURE_LABEL]: sigF } }).skip).toBe(false);
    const sigP = gateSystemDeploy({ spec: collector }, undefined).payload.spec.labels![SPEC_SIGNATURE_LABEL]!;
    expect(gateSystemDeploy({ spec: collector, pullPolicy: 'always' }, { labels: { [SPEC_SIGNATURE_LABEL]: sigP } }).skip).toBe(true);
  });

  it('user app deploys pass through untouched', () => {
    const p = { spec: { name: 'shop_web', image: 'nginx:1', labels: {} } };
    expect(gateSystemDeploy(p, { labels: {} })).toEqual({ payload: p, skip: false });
  });
});
