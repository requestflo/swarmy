import { describe, expect, it } from 'bun:test';
import { cloneDesired } from './clone-env';
import { toDesired } from './desired';
import { ownSecretCandidates, secretsRead, withOwnSecrets } from './own-secrets';
import { parseAppConfig } from './parse';
import type { AppConfig } from './schema';

const YAML = `version: 1
app: shop
services:
  web:
    image: ghcr.io/x/web:1
    port: 3000
    env:
      STRIPE_KEY: \${{ secrets.stripe-key }}
      NODE_ENV: production
  api:
    image: ghcr.io/x/api:1
    secrets: [stripe-key, sendgrid]
previews: { enabled: true, base_domain: preview.example.com }
environments:
  qa:
    branch: qa
`;

const cfg = (): AppConfig => {
  const r = parseAppConfig(YAML);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return r.config;
};
const svc = (d: ReturnType<typeof toDesired>, name: string) => d.services.find((s) => s.name === name)!;

describe('own secrets — an adopted environment keeps the family it filled', () => {
  const adopted = toDesired(cfg(), { environment: 'qa' });

  it('reads both ways a service can name a secret', () => {
    expect(secretsRead(svc(adopted, 'web'))).toEqual(['stripe-key']);
    expect(secretsRead(svc(adopted, 'api'))).toEqual(['sendgrid', 'stripe-key']);
    expect(ownSecretCandidates(adopted)).toEqual(['sendgrid.qa', 'stripe-key.qa']);
  });

  it('the per-environment family wins where it exists; the shared one stays where it does not', () => {
    const d = withOwnSecrets(adopted, new Set(['stripe-key.qa', 'stripe-key']));
    expect(svc(d, 'web').ownSecrets).toEqual({ 'stripe-key': 'stripe-key.qa' });
    expect(svc(d, 'api').ownSecrets).toEqual({ 'stripe-key': 'stripe-key.qa' });
    // The choice is part of the signature: a family appearing later redeploys onto it.
    expect(svc(d, 'web').sig).not.toBe(svc(adopted, 'web').sig);
    // What the app reads (the names) never changes.
    expect(svc(d, 'api').secrets).toEqual(['sendgrid', 'stripe-key']);
  });

  it('changes nothing without an own family, nor for production, previews or a dashboard environment', () => {
    expect(withOwnSecrets(adopted, new Set(['stripe-key']))).toBe(adopted);
    const prod = toDesired(cfg());
    expect(withOwnSecrets(prod, new Set(['stripe-key.production']))).toBe(prod);
    expect(ownSecretCandidates(prod)).toEqual([]);
    const preview = toDesired(cfg(), { preview: { pr: 4, baseDomain: 'preview.example.com' } });
    expect(withOwnSecrets(preview, new Set(['stripe-key.preview']))).toBe(preview);
    const clone = cloneDesired(cfg(), { name: 'demo', branch: 'demo', from: 'production' });
    expect(ownSecretCandidates(clone)).toEqual([]);
    expect(withOwnSecrets(clone, new Set(['stripe-key.demo']))).toBe(clone);
  });
});
