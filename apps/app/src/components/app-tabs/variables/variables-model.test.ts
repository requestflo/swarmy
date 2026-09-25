import { describe, expect, test } from 'bun:test';
import type { InvService } from '@swarmy/core';
import { collectVariables, variablesCode } from './variables-model';

const svc = (name: string, env: string[]): InvService => ({
  id: name, name: `shop_${name}`, image: 'x', stack: 'shop', mode: 'replicated',
  replicas: { desired: 1, running: 1 }, status: 'running', scaleToZero: false,
  labels: {}, networks: [], env, ports: [], containers: [],
});

describe('collectVariables', () => {
  const rows = collectVariables('shop', [
    svc('web', ['LOG_LEVEL=info', 'OTEL_SERVICE_NAME=shop-web', 'API_TOKEN=sk_live_abcdef1234567890']),
    svc('api', ['LOG_LEVEL=info', 'DATABASE_URL=${{ db.url }}', 'OTEL_SERVICE_NAME=shop-api']),
  ]);
  test('one row per key, across services', () => {
    expect(rows.find((r) => r.key === 'LOG_LEVEL')).toMatchObject({ value: 'info', services: ['api', 'web'], origin: 'you' });
  });
  test('bindings first, swarmy-injected last, differing values are null', () => {
    expect(rows[0]!.origin).toBe('binding');
    expect(rows.at(-1)).toMatchObject({ key: 'OTEL_SERVICE_NAME', origin: 'swarmy', value: null });
  });
  test('flags passwords kept as plain variables', () => {
    expect(rows.find((r) => r.key === 'API_TOKEN')?.secretLooking).toBe(true);
  });
  test('code never prints a secret-looking value', () => {
    const yaml = variablesCode('shop', [svc('web', ['API_TOKEN=sk_live_abcdef1234567890'])], [])[0]!.code;
    expect(yaml).not.toContain('sk_live');
    expect(yaml).toContain('API_TOKEN');
  });
});
