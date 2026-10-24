import { describe, expect, it } from 'bun:test';
import { applyHealthcheckEdit, healthcheckExecCmd, healthcheckTimeoutMs, HealthcheckEditError, httpProbeTest } from './healthcheck';
import { ServiceHealthcheckInput, UpdateServiceInput } from './inputs';

const LIVE = { test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/health'], intervalNs: 10e9, startPeriodNs: 15e9, retries: 3 };

describe('applyHealthcheckEdit — merged over the live check', () => {
  it('a field sent replaces, a field left out is kept', () => {
    expect(applyHealthcheckEdit(LIVE, { intervalSeconds: 5, timeoutSeconds: 2 })).toEqual({ ...LIVE, intervalNs: 5e9, timeoutNs: 2e9 });
  });

  it('0 hands a field back to Docker’s default', () => {
    expect(applyHealthcheckEdit(LIVE, { startPeriodSeconds: 0, retries: 0 })).toEqual({ test: LIVE.test, intervalNs: 10e9 });
  });

  it('an HTTP path becomes a curl-or-wget probe on the container’s own port', () => {
    expect(applyHealthcheckEdit(undefined, { http: { path: '/up?deep=1', port: 8080 } })).toEqual({
      test: ['CMD-SHELL', "curl -fsS -o /dev/null 'http://localhost:8080/up?deep=1' || wget -q -O /dev/null 'http://localhost:8080/up?deep=1'"],
    });
  });

  it('a bare argv runs as CMD; CMD-SHELL is kept', () => {
    expect(applyHealthcheckEdit(LIVE, { test: ['pg_isready', '-U', 'app'] })?.test).toEqual(['CMD', 'pg_isready', '-U', 'app']);
    expect(applyHealthcheckEdit(LIVE, { test: ['CMD-SHELL', 'redis-cli ping'] })?.test).toEqual(['CMD-SHELL', 'redis-cli ping']);
  });

  it('disable switches it off; null drops the service’s own check', () => {
    expect(applyHealthcheckEdit(LIVE, { disable: true })).toEqual({ disable: true });
    expect(applyHealthcheckEdit(LIVE, { test: ['NONE'] })).toEqual({ disable: true });
    expect(applyHealthcheckEdit(LIVE, null)).toBeUndefined();
  });

  it('turning a switched-off check back on starts fresh, and must say what to ask', () => {
    expect(applyHealthcheckEdit({ disable: true }, { test: ['CMD', 'true'], retries: 2 })).toEqual({ test: ['CMD', 'true'], retries: 2 });
    expect(() => applyHealthcheckEdit({ disable: true }, { intervalSeconds: 5 })).toThrow(HealthcheckEditError);
    expect(() => applyHealthcheckEdit(undefined, { retries: 2 })).toThrow(HealthcheckEditError);
  });
});

describe('ServiceHealthcheckInput', () => {
  it('takes one of http, test or disable', () => {
    expect(ServiceHealthcheckInput.safeParse({ http: { path: '/health', port: 80 } }).success).toBe(true);
    expect(ServiceHealthcheckInput.safeParse({ http: { path: '/health', port: 80 }, test: ['CMD', 'true'] }).success).toBe(false);
  });

  it('keeps quotes and spaces out of an HTTP path (it is single-quoted in a shell)', () => {
    for (const path of ["/x' ; rm -rf /", '/a b', 'health', '/a"b']) {
      expect(ServiceHealthcheckInput.safeParse({ http: { path, port: 80 } }).success).toBe(false);
    }
  });

  it('is additive on UpdateServiceInput (absent, an edit, or null)', () => {
    expect(UpdateServiceInput.parse({ id: 's' }).healthcheck).toBeUndefined();
    expect(UpdateServiceInput.parse({ id: 's', healthcheck: null }).healthcheck).toBeNull();
    expect(UpdateServiceInput.parse({ id: 's', healthcheck: { retries: 5 } }).healthcheck).toEqual({ retries: 5 });
  });
});

describe('running the check once', () => {
  it('reads the test the way Docker does', () => {
    expect(healthcheckExecCmd(LIVE.test)).toEqual(['wget', '-qO-', 'http://localhost:3000/health']);
    expect(healthcheckExecCmd(httpProbeTest('/h', 80))?.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(healthcheckExecCmd(['NONE'])).toBeNull();
    expect(healthcheckExecCmd([])).toBeNull();
    expect(healthcheckExecCmd(['CMD'])).toBeNull();
  });

  it('gives a probe the check’s timeout, else Docker’s 30 s', () => {
    expect(healthcheckTimeoutMs({ timeoutNs: 3e9 })).toBe(3000);
    expect(healthcheckTimeoutMs(undefined)).toBe(30_000);
  });
});
