import { describe, expect, test } from 'bun:test';
import type { InvService, SecretFamilyView, ServiceSecretVarView } from '@swarmy/core';
import { envText, rowsFor } from './var-table-model';

const svc = (name: string, env: string[]): InvService => ({
  id: name, name: `shop_${name}`, image: 'x', stack: 'shop', mode: 'replicated',
  replicas: { desired: 1, running: 1 }, status: 'running', scaleToZero: false,
  labels: {}, networks: [], env, ports: [], containers: [],
});
const sv = (key: string, delivery: 'env' | 'file' = 'env'): ServiceSecretVarView => ({
  key, delivery, version: 2, secretName: `x_${key}_v2`, updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'Ava', pendingCleanup: 0,
});
const fam = (family: string, ids: string[]): SecretFamilyView => ({
  family, currentVersion: 1, versions: [], lastRotatedAt: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z',
  consumers: ids.map((id) => ({ serviceId: id, serviceName: `shop_${id}`, stack: 'shop', version: 1, upToDate: true })),
  usedByCount: ids.length, staleConsumers: 0,
});

const services = [
  svc('web', ['LOG_LEVEL=info', 'SWARMY_SECRET_ENV=SESSION_KEY']),
  svc('api', ['LOG_LEVEL=debug', 'DATABASE_URL=${{ db.url }}', 'CERT_FILE=/run/secrets/CERT']),
];
const vars = { web: [sv('SESSION_KEY')], api: [sv('CERT', 'file')] };
const families = [fam('STRIPE_KEY', ['api']), fam('SMTP_PASSWORD', [])];

describe('rowsFor', () => {
  test('one table: connections, plain, secret vars, secret families; plumbing hidden', () => {
    const rows = rowsFor('shop', services, vars, families, null);
    expect(rows.map((r) => `${r.kind}:${r.key}`)).toEqual([
      'binding:DATABASE_URL', 'you:LOG_LEVEL', 'secretVar:CERT', 'secretVar:SESSION_KEY', 'family:SMTP_PASSWORD', 'family:STRIPE_KEY',
    ]);
    expect(rows.find((r) => r.key === 'LOG_LEVEL')?.value).toBeNull();
  });
  test('one service: its own values, only the secrets it reads', () => {
    const rows = rowsFor('shop', services, vars, families, 'api');
    expect(rows.find((r) => r.key === 'LOG_LEVEL')?.value).toBe('debug');
    expect(rows.filter((r) => r.kind === 'family').map((r) => r.key)).toEqual(['STRIPE_KEY']);
    expect(rows.some((r) => r.key === 'SESSION_KEY')).toBe(false);
  });
});

describe('envText', () => {
  test('never prints a secret value', () => {
    const text = envText(rowsFor('shop', [svc('web', ['API_TOKEN=sk_live_abcdef1234567890'])], {}, families, null), 'all services');
    expect(text).not.toContain('sk_live');
    expect(text).toContain('API_TOKEN=••••••');
    expect(text).toContain('# STRIPE_KEY is a secret');
  });
});
