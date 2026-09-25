import { describe, expect, test } from 'bun:test';
import { curl, toYaml } from './code';

describe('toYaml', () => {
  test('nested objects, arrays of objects, and quoting', () => {
    expect(
      toYaml({ data: { db: { postgres: 16, backup: 'nightly', standby: { on: 'new-york-1' } } }, ports: ['80:80'], env: [{ name: 'A', value: 'yes' }] }),
    ).toBe(
      'data:\n  db:\n    postgres: 16\n    backup: nightly\n    standby:\n      on: new-york-1\nports:\n  - "80:80"\nenv:\n  - name: A\n    value: "yes"',
    );
  });
  test('empty containers stay inline', () => {
    expect(toYaml({ a: [], b: {} })).toBe('a: []\nb: {}');
  });
});

describe('curl', () => {
  test('a body adds the content type and payload', () => {
    expect(curl('POST', '/services/web/scale', { replicas: 2 })).toContain(`-d '{"replicas":2}'`);
  });
});
