import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '../types';
import { appAuthVerifyPath } from '../app-auth';
import { buildCaddyfile } from './caddyfile';
import { buildNginxConfig } from './nginx';
import { buildTraefikDynamicYaml, buildTraefikLabels } from './traefik-labels';

/**
 * "Protect my app" goldens (dev-platform epic §2A). The Caddy render is the
 * reference: forward_auth to the controller inside a literal-order `route`,
 * every client-sent X-Swarmy-* header dropped first (host-wide AND in the
 * gate), the app-domain login callback outside the gate. Traefik (forwardAuth)
 * and nginx (auth_request) render the same contract.
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

const TRAEFIK_GOLDEN = `http:
  routers:
    web-app-example-com:
      rule: "Host(\`app.example.com\`)"
      service: "web-app-example-com"
      entryPoints: ["websecure"]
      middlewares: ["web-app-example-com-swarmy-strip", "web-app-example-com-swarmy-auth"]
      tls:
        certResolver: le
    swarmy-auth-app-example-com:
      rule: "Host(\`app.example.com\`) && PathPrefix(\`/.swarmy/auth/\`)"
      service: "swarmy-auth-app-example-com"
      entryPoints: ["websecure"]
      middlewares: ["swarmy-auth-app-example-com-path"]
      tls:
        certResolver: le
  services:
    web-app-example-com:
      loadBalancer:
        servers:
          - url: "http://web:3000"
    swarmy-auth-app-example-com:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "http://swarmy_controller:3021"
  middlewares:
    web-app-example-com-swarmy-strip:
      headers:
        customRequestHeaders:
          X-Swarmy-User: ""
          X-Swarmy-Email: ""
          X-Swarmy-Groups: ""
          X-Swarmy-Jwt: ""
          X-Swarmy-Original-Uri: ""
    web-app-example-com-swarmy-auth:
      forwardAuth:
        address: "http://swarmy_controller:3021/_app-auth/verify?org=org_1"
        trustForwardHeader: false
        authResponseHeaders: ["X-Swarmy-User", "X-Swarmy-Email", "X-Swarmy-Groups", "X-Swarmy-Jwt"]
    swarmy-auth-app-example-com-path:
      replacePathRegex:
        regex: '^/\\.swarmy/auth/(.*)'
        replacement: '/_app-auth/$1'
`;

const NGINX_GOLDEN = `server {
  listen 443 ssl;
  server_name app.example.com;
  ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;
  location /.swarmy/auth/ {
    proxy_pass http://swarmy_controller:3021/_app-auth/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  location = /_swarmy_verify {
    internal;
    proxy_pass http://swarmy_controller:3021/_app-auth/verify?org=org_1;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Uri $request_uri;
    proxy_set_header X-Forwarded-Method $request_method;
    proxy_set_header X-Swarmy-Auth-Mode status;
  }
  location @swarmy_login {
    rewrite ^ /_app-auth/login break;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Uri $request_uri;
    proxy_pass http://swarmy_controller:3021;
  }
  location / {
    auth_request /_swarmy_verify;
    auth_request_set $swarmy_user $upstream_http_x_swarmy_user;
    auth_request_set $swarmy_email $upstream_http_x_swarmy_email;
    auth_request_set $swarmy_groups $upstream_http_x_swarmy_groups;
    auth_request_set $swarmy_jwt $upstream_http_x_swarmy_jwt;
    error_page 401 = @swarmy_login;
    proxy_set_header X-Swarmy-User $swarmy_user;
    proxy_set_header X-Swarmy-Email $swarmy_email;
    proxy_set_header X-Swarmy-Groups $swarmy_groups;
    proxy_set_header X-Swarmy-Jwt $swarmy_jwt;
    proxy_pass http://web:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
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

describe('traefik — forwardAuth (golden)', () => {
  it('dynamic YAML: strip → forwardAuth chain + the app-domain callback router', () => {
    const out = buildTraefikDynamicYaml(cfg('traefik', [{ domain: 'app.example.com', service: 'web', port: 3000, auth: AUTH }]));
    expect(out).toBe(TRAEFIK_GOLDEN);
  });

  it('labels: the gate middlewares run before any user middleware', () => {
    const labels = buildTraefikLabels(
      cfg('traefik', [
        { domain: 'app.example.com', service: 'web', port: 3000, auth: AUTH, middlewares: ['gzip@file'] },
      ]),
    ).get('web')!;
    expect(labels['traefik.http.routers.web-app-example-com.middlewares']).toBe(
      'web-app-example-com-swarmy-strip,web-app-example-com-swarmy-auth,gzip@file',
    );
    expect(labels['traefik.http.middlewares.web-app-example-com-swarmy-auth.forwardauth.address']).toBe(
      'http://swarmy_controller:3021/_app-auth/verify?org=org_1',
    );
    expect(labels['traefik.http.middlewares.web-app-example-com-swarmy-strip.headers.customrequestheaders.X-Swarmy-User']).toBe('');
  });
});

describe('nginx — auth_request (golden)', () => {
  it('renders callback, internal verify (status mode), login fallback and the gated location', () => {
    const out = buildNginxConfig(cfg('nginx', [{ domain: 'app.example.com', service: 'web', port: 3000, auth: AUTH }]));
    expect(out).toBe(NGINX_GOLDEN);
  });
});
