import { describe, expect, it } from 'bun:test';
import { EMAIL_AUTO_ENV, emailEnvFor, wholeEmailBinding } from './email';
import { toDesired } from './desired';
import { parseAppConfig } from './parse';

const yaml = (extra: string, webEnv = '') => `version: 1
app: shop
services:
  web:
    image: ghcr.io/acme/web:1
    port: 3000${webEnv}
  worker:
    image: ghcr.io/acme/worker:1
${extra}`;

const errors = (text: string) => parseAppConfig(text).issues.filter((i) => i.severity === 'error').map((i) => i.code);

describe('swarmy.yaml email:', () => {
  it('email: true binds SMTP_* and EMAIL_API_* into every service', () => {
    const r = parseAppConfig(yaml('email: true\n'));
    expect(errors(yaml('email: true\n'))).toEqual([]);
    const d = toDesired(r.config!);
    expect(d.email).toEqual({ from: null, services: ['web', 'worker'] });
    const web = d.services.find((s) => s.name === 'web')!;
    expect(web.email?.env).toEqual(EMAIL_AUTO_ENV);
    expect(Object.keys(web.email!.env)).toEqual(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'EMAIL_FROM', 'EMAIL_API_URL', 'EMAIL_API_KEY']);
  });

  it('from + services narrow the binding', () => {
    const d = toDesired(parseAppConfig(yaml('email:\n  from: NoReply@Shop.Example.com\n  services: [worker]\n')).config!);
    expect(d.email).toEqual({ from: 'noreply@shop.example.com', services: ['worker'] });
    expect(d.services.find((s) => s.name === 'web')!.email).toBeUndefined();
    expect(d.services.find((s) => s.name === 'worker')!.email?.from).toBe('noreply@shop.example.com');
  });

  it('templates bind their own names with ${{ email.<field> }}', () => {
    const text = yaml('email:\n  services: [worker]\n', '\n    env:\n      MAIL_PASSWORD: ${{ email.password }}\n      MAIL_HOST: ${{email.host}}');
    expect(errors(text)).toEqual([]);
    const web = toDesired(parseAppConfig(text).config!).services.find((s) => s.name === 'web')!;
    expect(web.email?.env).toEqual({ MAIL_PASSWORD: 'password', MAIL_HOST: 'host' });
  });

  it('a service that sets an auto name itself keeps it', () => {
    expect(emailEnvFor({ from: null, services: ['web'] }, 'web', { SMTP_HOST: 'smtp.other' })).not.toHaveProperty('SMTP_HOST');
  });

  it('rejects email bindings without email:, embedded, unknown fields or services', () => {
    expect(errors(yaml('', '\n    env:\n      P: ${{ email.password }}'))).toContain('email/not-enabled');
    expect(errors(yaml('email: true\n', '\n    env:\n      URL: smtp://${{ email.user }}@x'))).toContain('email/embedded');
    expect(errors(yaml('email: true\n', '\n    env:\n      X: ${{ email.nope }}'))).toContain('binding/unknown-field');
    expect(errors(yaml('email:\n  services: [nope]\n'))).toContain('email/unknown-service');
    expect(errors(yaml('email:\n  from: not-an-address\n')).length).toBeGreaterThan(0);
  });

  it('a changed sender changes the bound service signature (redeploy + rebind)', () => {
    const a = toDesired(parseAppConfig(yaml('email:\n  from: a@example.com\n')).config!);
    const b = toDesired(parseAppConfig(yaml('email:\n  from: b@example.com\n')).config!);
    expect(a.services[0]!.sig).not.toBe(b.services[0]!.sig);
  });

  it('wholeEmailBinding only matches a whole known field', () => {
    expect(wholeEmailBinding(' ${{ email.api_key }} ')).toBe('api_key');
    expect(wholeEmailBinding('x${{ email.api_key }}')).toBeNull();
    expect(wholeEmailBinding('${{ email.bogus }}')).toBeNull();
  });
});
