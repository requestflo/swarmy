import { describe, expect, it } from 'bun:test';
import { isPrivateHost } from './private-host';

// Mirror of packages/ingress/src/render/caddyfile.test.ts (isPrivateHost).
describe('isPrivateHost (dashboard mirror of the ingress helper)', () => {
  it('flags LAN names, loopback, and private-IP wildcard-DNS hosts', () => {
    for (const h of [
      'localhost',
      'blog.local',
      'wp.lan',
      'app.internal',
      'nas.home.arpa',
      '192.168.1.10',
      '10.0.0.5',
      '172.20.3.4',
      '100.64.1.1',
      '192.168.1.10.sslip.io',
      'wp.192-168-1-10.nip.io',
      'wp-10-0-0-5.sslip.io',
      ' Blog.LOCAL. ',
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  it('leaves public hosts alone', () => {
    for (const h of [
      'blog.example.com',
      'example.com',
      '8.8.8.8',
      '203.0.113.7.sslip.io',
      '172.32.0.1',
      'localhost.example.com',
      '',
    ]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});
