import { describe, expect, test } from 'bun:test';
import { editOf, formOf, previewOf } from './health-draft';

const WGET = { test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/health'], intervalNs: 10e9, startPeriodNs: 15e9, retries: 3 };

describe('formOf — the live check as a form', () => {
  test('an HTTP probe reads as path + port; blank durations are Docker’s defaults', () => {
    expect(formOf(WGET)).toEqual({ ask: 'http', path: '/health', port: '3000', command: 'wget -qO- http://localhost:3000/health', interval: '10', timeout: '', retries: '3', start: '15' });
  });

  test('a command, an off switch, and no check at all', () => {
    expect(formOf({ test: ['CMD-SHELL', 'pg_isready -U app'] })).toMatchObject({ ask: 'command', command: 'pg_isready -U app' });
    expect(formOf({ disable: true }).ask).toBe('off');
    expect(formOf(undefined, 8080)).toMatchObject({ ask: 'http', path: '/health', port: '8080' });
  });
});

describe('editOf — only what changed', () => {
  const base = formOf(WGET);

  test('nothing changed → nothing to save', () => {
    expect(editOf(base, base, false)).toEqual({ edit: null, error: null });
  });

  test('changing a duration leaves the probe alone; blank hands it back to the default', () => {
    expect(editOf(base, { ...base, interval: '5', start: '' }, false).edit).toEqual({ intervalSeconds: 5, startPeriodSeconds: 0 });
  });

  test('a new path or port sends the HTTP probe; a command sends CMD-SHELL', () => {
    expect(editOf(base, { ...base, path: '/up' }, false).edit).toEqual({ http: { path: '/up', port: 3000 } });
    expect(editOf(base, { ...base, ask: 'command', command: 'redis-cli ping' }, false).edit).toEqual({ test: ['CMD-SHELL', 'redis-cli ping'] });
  });

  test('a service with no check of its own always sends the probe', () => {
    const none = formOf(undefined, 8080);
    expect(editOf(none, none, true).edit).toEqual({ http: { path: '/health', port: 8080 } });
  });

  test('off is one switch', () => {
    expect(editOf(base, { ...base, ask: 'off' }, false).edit).toEqual({ disable: true });
  });

  test('bad input says why in plain words', () => {
    expect(editOf(base, { ...base, path: '/a b' }, false).error).toMatch(/no spaces/);
    expect(editOf(base, { ...base, port: '' }, false).error).toMatch(/port/);
    expect(editOf(base, { ...base, interval: 'soon' }, false).error).toMatch(/seconds/);
    expect(editOf(base, { ...base, retries: '1.5' }, false).error).toMatch(/whole number/);
  });
});

describe('previewOf — the check after Save', () => {
  test('applies the edit, or keeps the live check when it can’t', () => {
    expect(previewOf(WGET, { intervalSeconds: 5 })?.intervalNs).toBe(5e9);
    expect(previewOf(undefined, { retries: 2 })).toBeUndefined();
    expect(previewOf(WGET, null)).toBe(WGET);
  });
});
