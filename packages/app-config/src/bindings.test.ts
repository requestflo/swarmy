import { describe, expect, it } from 'bun:test';
import { extractBindings, parseBindingExpr, refKey, renderValue } from './bindings';

describe('bindings', () => {
  it('parses each namespace', () => {
    expect(parseBindingExpr('db.url').ref).toEqual({ ns: 'resource', name: 'db', field: 'url' });
    expect(parseBindingExpr('services.api.url').ref).toEqual({
      ns: 'service',
      name: 'api',
      field: 'url',
    });
    expect(parseBindingExpr('app.url').ref).toEqual({ ns: 'app', field: 'url' });
    expect(parseBindingExpr('secrets.stripe-key').ref).toEqual({
      ns: 'secret',
      name: 'stripe-key',
    });
  });

  it('rejects malformed expressions with a hint', () => {
    expect(parseBindingExpr('db').error).toContain('<resource>.<field>');
    expect(parseBindingExpr('services.api').error).toContain('services.<name>.<field>');
    expect(parseBindingExpr('db.url | upper').ref).toBeNull();
  });

  it('extracts embedded bindings, skips $$ escapes and compose ${VAR}', () => {
    const got = extractBindings('postgres://x@${{ db.host }}:${{db.port}}/${VAR} $${{ not.me }}');
    expect(got.map((b) => b.expr)).toEqual(['db.host', 'db.port']);
  });

  it('renders from a resolved map and reports what is missing', () => {
    const resolved = {
      'db.url': 'postgres://orders_db-primary:5432/db',
      'services.api.url': 'http://api:8080',
    };
    expect(renderValue('${{ db.url }}', resolved)).toEqual({
      value: 'postgres://orders_db-primary:5432/db',
      missing: [],
    });
    expect(renderValue('api=${{ services.api.url }}/v1', resolved).value).toBe(
      'api=http://api:8080/v1',
    );
    expect(renderValue('$${{ db.url }}', resolved).value).toBe('${{ db.url }}');
    expect(renderValue('${{ cache.url }}', resolved)).toEqual({
      value: '${{ cache.url }}',
      missing: ['cache.url'],
    });
  });

  it('refKey is stable per namespace', () => {
    expect(refKey({ ns: 'secret', name: 's' })).toBe('secrets.s');
    expect(refKey({ ns: 'service', name: 'a', field: 'host' })).toBe('services.a.host');
  });
});
