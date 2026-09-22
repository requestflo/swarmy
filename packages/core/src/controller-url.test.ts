import { describe, expect, it } from 'bun:test';
import { isLoopbackUrl, normaliseBaseUrl, resolveControllerPublicUrl, safeBaseUrl } from './controller-url';

const h = (rec: Record<string, string>): Headers => new Headers(rec);

describe('isLoopbackUrl', () => {
  it('flags localhost / 127/8 / ::1 / 0.0.0.0', () => {
    for (const u of ['http://localhost:3021', 'http://127.0.0.1', 'http://127.1.2.3:80', 'http://[::1]:3021', 'http://0.0.0.0:3021', 'http://app.localhost']) {
      expect(isLoopbackUrl(u)).toBe(true);
    }
  });
  it('passes LAN + public addresses', () => {
    for (const u of ['http://192.168.11.87:3021', 'https://swarmy.example.com', 'http://10.0.0.5']) {
      expect(isLoopbackUrl(u)).toBe(false);
    }
  });
});

describe('resolveControllerPublicUrl', () => {
  it('a real CONTROLLER_PUBLIC_URL is authoritative (headers ignored)', () => {
    const r = resolveControllerPublicUrl({
      configured: 'https://swarmy.example.com/',
      headers: h({ host: '192.168.1.2:3021' }),
    });
    expect(r).toEqual({ url: 'https://swarmy.example.com', source: 'config', loopback: false, warning: null });
  });

  it('unset/localhost config → the address the request actually used (Host)', () => {
    const r = resolveControllerPublicUrl({ configured: 'http://localhost:3021', headers: h({ host: '192.168.11.87:3021' }) });
    expect(r.url).toBe('http://192.168.11.87:3021');
    expect(r.source).toBe('host');
    expect(r.loopback).toBe(false);
  });

  it('X-Forwarded-Host/Proto beat Origin beat Host', () => {
    const headers = h({
      host: 'localhost:3021',
      origin: 'http://192.168.1.9:3023',
      'x-forwarded-host': 'swarmy.lan, proxy.internal',
      'x-forwarded-proto': 'https',
    });
    expect(resolveControllerPublicUrl({ configured: undefined, headers }).url).toBe('https://swarmy.lan');
    headers.delete('x-forwarded-host');
    const viaOrigin = resolveControllerPublicUrl({ configured: undefined, headers });
    expect(viaOrigin).toMatchObject({ url: 'http://192.168.1.9:3023', source: 'origin' });
  });

  it('honours RFC 7239 Forwarded', () => {
    const r = resolveControllerPublicUrl({ headers: h({ forwarded: 'for=1.2.3.4;host=ctl.example.com;proto=https', host: 'localhost' }) });
    expect(r.url).toBe('https://ctl.example.com');
  });

  it('dev proxy: loopback Host but a real browser Origin → Origin', () => {
    const r = resolveControllerPublicUrl({
      configured: 'http://localhost:3021',
      headers: h({ host: 'localhost:3021', origin: 'http://192.168.11.87:3023' }),
    });
    expect(r.url).toBe('http://192.168.11.87:3023');
  });

  it('everything loopback → flagged with a set-CONTROLLER_PUBLIC_URL warning', () => {
    const r = resolveControllerPublicUrl({ configured: 'http://localhost:3021', headers: h({ host: 'localhost:3023' }) });
    expect(r.loopback).toBe(true);
    expect(r.url).toBe('http://localhost:3021');
    expect(r.warning).toContain('CONTROLLER_PUBLIC_URL');
  });

  it('never lets a hostile Host/Origin into a shell body', () => {
    const r = resolveControllerPublicUrl({
      headers: h({ host: 'evil$(reboot):80', origin: 'http://a"b', 'x-forwarded-host': "x';rm -rf /;'" }),
    });
    expect(r.url).toBe('http://localhost:3021');
    expect(r.loopback).toBe(true);
    expect(safeBaseUrl('javascript', 'a.b')).toBeNull();
    expect(normaliseBaseUrl('http://ok.example/$(x)')).toBeNull();
  });

  it('accepts a plain record of headers too', () => {
    const r = resolveControllerPublicUrl({ headers: { Host: '10.0.0.5:3021' } });
    expect(r.url).toBe('http://10.0.0.5:3021');
  });
});
