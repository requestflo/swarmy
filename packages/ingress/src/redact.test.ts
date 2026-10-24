import { describe, expect, it } from 'bun:test';
import type { RenderedConfig } from '@swarmy/core/protocol';
import { SEALED, redactRenderedSecrets } from './redact';

const HASH = `$2a$10$${'a'.repeat(53)}`;

const rendered = (over: Partial<RenderedConfig>): RenderedConfig => ({
  driver: 'cloudflared',
  files: [],
  serviceLabels: [],
  summary: '',
  ...over,
});

describe('redactRenderedSecrets — a preview never carries a decrypted secret', () => {
  it('seals a tunnel run token, keeping its name and vault ref', () => {
    const r = redactRenderedSecrets(
      rendered({
        connector: {
          kind: 'cloudflared',
          service: { name: 'swarmy-cloudflared', image: 'cloudflare/cloudflared' } as never,
          secrets: [{ name: 'cloudflared-token', ref: 'tunnel.runToken', value: 'eyJhIjoiLi4uIn0' }],
        },
      }),
    );
    expect(r.connector?.secrets).toEqual([{ name: 'cloudflared-token', ref: 'tunnel.runToken', value: SEALED }]);
    expect(JSON.stringify(r)).not.toContain('eyJhIjoiLi4uIn0');
  });

  it('seals owner-only files (tunnel credentials) and leaves config files as they are', () => {
    const r = redactRenderedSecrets(
      rendered({
        files: [
          { path: '/etc/cloudflared/config.yml', contents: 'tunnel: abc', mode: 0o644 },
          { path: '/etc/cloudflared/creds.json', contents: '{"TunnelSecret":"s3cr3t"}', mode: 0o600 },
        ],
      }),
    );
    expect(r.files.map((f) => f.contents)).toEqual(['tunnel: abc', SEALED]);
  });

  it('still hides route-password hashes', () => {
    const r = redactRenderedSecrets(
      rendered({ driver: 'caddy', files: [{ path: '/etc/caddy/Caddyfile', contents: `basic_auth {\n  ops ${HASH}\n}`, mode: 0o644 }] }),
    );
    expect(r.files[0]!.contents).not.toContain(HASH);
  });
});
