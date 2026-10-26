import { describe, expect, it } from 'bun:test';
import { declaredEnv, declaredEnvByService } from './declared-env';
import { parseAppConfig } from './parse';
import type { AppConfig } from './schema';

const YAML = `version: 1
app: shop
env: { NODE_ENV: production, LOG_LEVEL: info }
services:
  web:
    image: ghcr.io/x/web:1
    env: { API_URL: "\${{ services.api.url }}", LOG_LEVEL: warn }
  api:
    image: ghcr.io/x/api:1
    port: 8080
    env: { DATABASE_URL: "\${{ db.url }}" }
resources:
  db: postgres
environments:
  staging:
    branch: staging
    env: { LOG_LEVEL: debug, FEATURE_X: "on" }
    services:
      api: { env: { DATABASE_URL: "\${{ db.ro_url }}" } }
`;

const cfg = (): AppConfig => {
  const r = parseAppConfig(YAML);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return r.config;
};

describe('declaredEnv (board 58 locked rows)', () => {
  it('production: shared env, then the service’s own, the winner’s path', () => {
    expect(declaredEnv(cfg(), 'production', 'web')).toEqual({
      NODE_ENV: 'env.NODE_ENV',
      LOG_LEVEL: 'services.web.env.LOG_LEVEL',
      API_URL: 'services.web.env.API_URL',
    });
  });

  it('a named environment layers its env under the service and its per-service env over it', () => {
    expect(declaredEnv(cfg(), 'staging', 'api')).toEqual({
      NODE_ENV: 'env.NODE_ENV',
      LOG_LEVEL: 'environments.staging.env.LOG_LEVEL',
      FEATURE_X: 'environments.staging.env.FEATURE_X',
      DATABASE_URL: 'environments.staging.services.api.env.DATABASE_URL',
    });
    // services.web.env beats environments.staging.env (service env › environment env › shared).
    expect(declaredEnv(cfg(), 'staging', 'web').LOG_LEVEL).toBe('services.web.env.LOG_LEVEL');
  });

  it('a dashboard clone reads as the environment it came from; an unknown service gets the shared layers', () => {
    expect(declaredEnv(cfg(), 'qa', 'api', 'staging')).toEqual(declaredEnv(cfg(), 'staging', 'api'));
    expect(declaredEnv(cfg(), 'qa', 'api')).toEqual(declaredEnv(cfg(), 'production', 'api'));
    expect(declaredEnv(cfg(), 'production', 'cron')).toEqual({ NODE_ENV: 'env.NODE_ENV', LOG_LEVEL: 'env.LOG_LEVEL' });
  });

  it('by service', () => {
    expect(Object.keys(declaredEnvByService(cfg(), 'production'))).toEqual(['web', 'api']);
  });
});
