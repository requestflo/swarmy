import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '../types';
import { appAuthVerifyPath } from '../app-auth';
import { buildCaddyfile } from './caddyfile';

/**
 * "Protect my app" goldens (dev-platform epic §2A). The Caddy render is the
 * reference: forward_auth to the controller inside a literal-order `route`,
 * every client-sent X-Swarmy-* header dropped first (host-wide AND in the
 * gate), the app-domain login callback outside the gate.
 */

const AUTH = { upstream: 'swarmy_controller:3021', verifyPath: appAuthVerifyPath('org_1') };

function cfg(driver: string, domains: Record<string, unknown>[]): IngressConfig {
  return IngressConfigSchema.parse({ driver, orgId: 'org_1', domains });
}

const CADDY_GOLDEN = `app.example.com {
  request_header -X-Swarmy-*
  # swarmy app login callback (sets the first-party session cookie)
  handle_path /.swarmy/auth/* {
    rewrite * /_app-auth{uri}
    reverse_proxy swarmy_controller:3021
  }
  handle {
    route {
      request_header -X-Swarmy-*
      forward_auth swarmy_controller:3021 {
        uri /_app-auth/verify?org=org_1
        header_up X-Swarmy-Original-Uri {http.request.orig_uri}
        copy_headers X-Swarmy-User X-Swarmy-Email X-Swarmy-Groups X-Swarmy-Jwt
      }
      reverse_proxy web:3000 {
        stream_close_delay 5m
      }
    }
  }
}

mixed.example.com {
  request_header -X-Swarmy-*
  # swarmy app login callback (sets the first-party session cookie)
  handle_path /.swarmy/auth/* {
    rewrite * /_app-auth{uri}
    reverse_proxy swarmy_controller:3021
  }
  handle_path /api* {
    route {
      @deny_mixed_example_com_api remote_ip 1.2.3.4
      abort @deny_mixed_example_com_api
      request_header -X-Swarmy-*
      forward_auth swarmy_controller:3021 {
        uri /_app-auth/verify?org=org_1
        header_up X-Swarmy-Original-Uri {http.request.orig_uri}
        copy_headers X-Swarmy-User X-Swarmy-Email X-Swarmy-Groups X-Swarmy-Jwt
      }
      reverse_proxy api:8080 {
        stream_close_delay 5m
      }
    }
  }
  handle {
    reverse_proxy site:80 {
      stream_close_delay 5m
    }
  }
}
`;

describe('caddy — protected routes (golden)', () => {
  it('renders the callback, header strip, forward_auth and proxy in order', () => {
    const out = buildCaddyfile(
      cfg('caddy', [
        { domain: 'app.example.com', service: 'web', port: 3000, auth: AUTH },
        {
          domain: 'mixed.example.com',
          service: 'api',
          port: 8080,
          pathPrefix: '/api',
          stripPathPrefix: true,
          auth: AUTH,
          protection: { ipDeny: ['1.2.3.4'], cache: { ttlSeconds: 60 } },
        },
        { domain: 'mixed.example.com', service: 'site', port: 80 },
      ]),
    );
    expect(out).toBe(CADDY_GOLDEN);
  });

  it('never caches a protected route (one user page must never serve the next)', () => {
    const out = buildCaddyfile(
      cfg('caddy', [
        { domain: 'a.example.com', service: 'web', port: 3000, auth: AUTH, protection: { cache: { ttlSeconds: 30 } } },
      ]),
    );
    expect(out).not.toContain('cache');
  });

  it('gates a cold route before the wake rewrite (anonymous callers never wake it)', () => {
    const out = buildCaddyfile(
      cfg('caddy', [
        {
          domain: 'cold.example.com',
          service: 'web',
          port: 3000,
          auth: AUTH,
          cold: { upstream: 'swarmy_controller:3021', wakePath: '/_wake/web' },
        },
      ]),
    );
    const gate = out.indexOf('forward_auth');
    const wake = out.indexOf('rewrite * /_wake/web');
    expect(gate).toBeGreaterThan(0);
    expect(wake).toBeGreaterThan(gate);
  });

  it('an unprotected host renders exactly as before (no gate, no callback, no strip)', () => {
    const out = buildCaddyfile(cfg('caddy', [{ domain: 'open.example.com', service: 'web', port: 3000 }]));
    expect(out).toBe(
      ['open.example.com {', '  reverse_proxy web:3000 {', '    stream_close_delay 5m', '  }', '}', ''].join('\n'),
    );
  });
});
