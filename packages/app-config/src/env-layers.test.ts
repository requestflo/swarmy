import { describe, expect, it } from 'bun:test';
import { toDesired } from './desired';
import { envLayers, isOverride, MASKED_VALUE, maskEnvValue } from './env-layers';
import { parseAppConfig } from './parse';
import type { AppConfig } from './schema';

const YAML = `version: 1
app: shop
env:
  NODE_ENV: production
  LOG_LEVEL: info
  STRIPE_SECRET_KEY: sk_live_abcdefghijklmnop1234
services:
  web:
    image: ghcr.io/x/web:1
    port: 3000
    env:
      LOG_LEVEL: warn
      DATABASE_URL: \${{ db.url }}
  api:
    image: ghcr.io/x/api:1
resources:
  db: postgres
environments:
  staging:
    branch: staging
    env: { LOG_LEVEL: debug, FEATURE_FLAGS: beta }
    services:
      api: { env: { NODE_ENV: staging } }
`;

const cfg = (): AppConfig => {
  const r = parseAppConfig(YAML);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return r.config;
};

describe('envLayers — service env › environments.<name>.env › shared env', () => {
  const layers = envLayers(cfg(), ['qa']);
  const row = (k: string) => layers.rows.find((r) => r.key === k)!;

  it('lists production, the file’s environments, then dashboard ones', () => {
    expect(layers.environments).toEqual(['production', 'staging', 'qa']);
    // DATABASE_URL is only a service variable: no environment touches it.
    expect(layers.rows.map((r) => r.key)).toEqual(['FEATURE_FLAGS', 'LOG_LEVEL', 'NODE_ENV', 'STRIPE_SECRET_KEY']);
  });

  it('names the layer each value comes from', () => {
    const log = row('LOG_LEVEL');
    expect(log.shared).toBe('info');
    expect(log.envs.production).toEqual({ value: 'info', origin: 'shared', services: [{ service: 'web', value: 'warn', layer: 'service' }] });
    expect(log.envs.staging).toEqual({ value: 'debug', origin: 'environment', services: [{ service: 'web', value: 'warn', layer: 'service' }] });
    expect(row('FEATURE_FLAGS').envs.production).toEqual({ value: null, origin: null, services: [] });
    expect(row('NODE_ENV').envs.staging?.services).toEqual([{ service: 'api', value: 'staging', layer: 'environment' }]);
  });

  it('agrees with what toDesired actually deploys', () => {
    const staging = toDesired(cfg(), { environment: 'staging' });
    const env = (svc: string) => staging.services.find((s) => s.name === svc)!.env;
    expect(env('web').LOG_LEVEL).toBe('warn'); // the service's own value wins
    expect(env('api').LOG_LEVEL).toBe('debug'); // environments.staging.env over shared
    expect(env('api').NODE_ENV).toBe('staging'); // the environment's service override
    expect(env('web').NODE_ENV).toBe('production'); // shared
  });

  it('marks an override only where an environment changes something', () => {
    expect(isOverride(row('LOG_LEVEL').envs.staging)).toBe(true);
    expect(isOverride(row('LOG_LEVEL').envs.production)).toBe(false);
    expect(isOverride(row('NODE_ENV').envs.staging)).toBe(true);
    expect(isOverride(row('NODE_ENV').envs.qa)).toBe(false); // a dashboard environment has no layer of its own
  });

  it('masks secret-looking values everywhere, never a binding', () => {
    const s = row('STRIPE_SECRET_KEY');
    expect(s.secret).toBe(true);
    expect(s.shared).toBe(MASKED_VALUE);
    expect(s.envs.staging?.value).toBe(MASKED_VALUE);
    expect(JSON.stringify(layers)).not.toContain('sk_live');
    expect(maskEnvValue('DATABASE_PASSWORD', '${{ db.url }}')).toEqual({ value: '${{ db.url }}', masked: false });
    expect(maskEnvValue('DATABASE_PASSWORD', 'hunter2')).toEqual({ value: MASKED_VALUE, masked: true });
  });
});
