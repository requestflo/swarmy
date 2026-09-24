import { describe, expect, it } from 'bun:test';
import { parseAppConfig, toDesired } from '@swarmy/app-config';
import { END_USER_AUTH_EXAMPLE, PROTECT_MY_APP_EXAMPLE } from './app-auth';

describe('app auth examples', () => {
  it('Protect my app parses clean (the gate is a dashboard toggle, not yaml)', () => {
    const r = parseAppConfig(PROTECT_MY_APP_EXAMPLE);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('end-user auth deploys a swarmy-auth service on the app Postgres, routed at /auth/', () => {
    const r = parseAppConfig(END_USER_AUTH_EXAMPLE);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const d = toDesired(r.config!);
    const auth = d.services.find((s) => s.name === 'swarmy-auth')!;
    expect(auth.env.DATABASE_URL).toBe('${{ db.url }}');
    expect(auth.secrets).toContain('auth-github-client-secret');
    expect(d.routes.some((x) => x.host === 'shop.example.com' && x.path === '/auth/' && x.service === 'swarmy-auth')).toBe(true);
    expect(d.services.find((s) => s.name === 'web')!.env.SWARMY_AUTH_URL).toBe('http://shop_swarmy-auth:3000');
  });
});
