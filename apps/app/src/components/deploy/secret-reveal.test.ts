import { describe, expect, it } from 'bun:test';
import { revealRow } from './secret-reveal';

describe('revealRow (one row per one-time secret)', () => {
  it('a template login: label, the login in the clear, the secret to mask', () => {
    expect(revealRow('Grafana admin login: admin / Xy12abc (shown once, so save it now)')).toEqual({ label: 'Grafana admin login', login: 'admin', secret: 'Xy12abc' });
  });

  it('the Directus form, with an em dash', () => {
    expect(revealRow('Directus admin login — ops@northwind.dev / k9Qz (shown once, save it now)')).toEqual({ label: 'Directus admin login', login: 'ops@northwind.dev', secret: 'k9Qz' });
  });

  it('a bare key has no login', () => {
    expect(revealRow('LiteLLM admin key: sk-abc123 (shown once, so save it now)')).toEqual({ label: 'LiteLLM admin key', login: null, secret: 'sk-abc123' });
  });

  it('anything else is one secret, whole', () => {
    expect(revealRow('p4ssw0rd')).toEqual({ label: 'Secret', login: null, secret: 'p4ssw0rd' });
  });
});
