import { describe, expect, it } from 'bun:test';
import { safeReturn } from './activator-return';

describe('activator return target (no open redirect from /_wake)', () => {
  it('keeps same-origin paths and same-host absolute URLs', () => {
    expect(safeReturn('/dash?x=1', 'app.example.com')).toBe('/dash?x=1');
    expect(safeReturn('https://app.example.com/a?b=1', 'app.example.com')).toBe('https://app.example.com/a?b=1');
    expect(safeReturn('http://app.example.com/', 'APP.example.com:443')).toBe('http://app.example.com/');
  });

  it('drops other hosts, protocol-relative paths and non-http schemes', () => {
    expect(safeReturn('https://evil.example/', 'app.example.com')).toBeNull();
    expect(safeReturn('https://app.example.com.evil.io/', 'app.example.com')).toBeNull();
    expect(safeReturn('//evil.example/', 'app.example.com')).toBeNull();
    expect(safeReturn('/\\evil.example/', 'app.example.com')).toBeNull();
    expect(safeReturn('javascript:alert(1)', 'app.example.com')).toBeNull();
    expect(safeReturn('https://app.example.com/', undefined)).toBeNull();
    expect(safeReturn(undefined, 'app.example.com')).toBeNull();
  });
});
