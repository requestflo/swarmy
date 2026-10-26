import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '../types';
import { buildCaddyfile } from './caddyfile';

/**
 * Request-id goldens (board 59). Every app site mints one id per request
 * (`{http.request.uuid}`), sends it upstream as X-Request-Id (replacing a
 * client-sent copy) and returns it unless the app set its own (`?`). With
 * tracing on, the edge span carries it as `swarmy.request_id`. A redirect-only
 * site never proxies, so it carries none.
 */

function cfg(domains: Record<string, unknown>[], global: Record<string, unknown> = {}, extra: Partial<IngressConfig> = {}): IngressConfig {
  return IngressConfigSchema.parse({ driver: 'caddy', orgId: 'org_1', domains, globalOptions: global, ...extra });
}

describe('caddy request id', () => {
  it('a plain site: minted, sent upstream, returned when the app sets none', () => {
    expect(buildCaddyfile(cfg([{ domain: 'shop.example.com', service: 'web', port: 3000 }]))).toBe(`shop.example.com {
  # swarmy request id: one per request, sent upstream and back to the browser
  request_header X-Request-Id {http.request.uuid}
  header ?X-Request-Id {http.request.uuid}
  reverse_proxy web:3000 {
    stream_close_delay 5m
  }
}
`);
  });

  it('after the TLS lines, before every route handle', () => {
    const out = buildCaddyfile(
      cfg([
        { domain: 'shop.local', service: 'web', port: 3000 },
        { domain: 'shop.local', service: 'api', port: 8080, pathPrefix: '/api' },
      ]),
    );
    expect(out).toBe(`shop.local {
  tls internal
  # swarmy request id: one per request, sent upstream and back to the browser
  request_header X-Request-Id {http.request.uuid}
  header ?X-Request-Id {http.request.uuid}
  handle /api* {
    reverse_proxy api:8080 {
      stream_close_delay 5m
    }
  }
  handle {
    reverse_proxy web:3000 {
      stream_close_delay 5m
    }
  }
}
`);
  });

  it('tracing on: the edge span carries the same id', () => {
    const out = buildCaddyfile(cfg([{ domain: 'shop.example.com', service: 'web', port: 3000, tls: 'off' }], { tracing: true }));
    expect(out).toBe(`{
  order tracing first
}

http://shop.example.com {
  tracing {
    span swarmy-edge
    span_attributes {
      swarmy.request_id {http.request.uuid}
    }
  }
  # swarmy request id: one per request, sent upstream and back to the browser
  request_header X-Request-Id {http.request.uuid}
  header ?X-Request-Id {http.request.uuid}
  reverse_proxy web:3000 {
    stream_close_delay 5m
  }
}
`);
  });

  it('a cold (asleep) route gets one too: the wake page is a response like any other', () => {
    const out = buildCaddyfile(
      cfg([{ domain: 'a.example.com', service: 'web', port: 3000, cold: { upstream: 'swarmy_controller:3021', wakePath: '/_activator/wake/x' } }]),
    );
    expect(out).toContain('  request_header X-Request-Id {http.request.uuid}\n  header ?X-Request-Id {http.request.uuid}\n  rewrite * /_activator/wake/x');
  });

  it('a redirect-only site never proxies, so it carries no id', () => {
    const out = buildCaddyfile(
      cfg([{ domain: 'acme.com', service: 'web', port: 3000 }], {}, { hostRedirects: [{ from: 'www.acme.com', to: 'acme.com', tls: 'auto' }] }),
    );
    expect(out).toContain(['www.acme.com {', '  # swarmy www redirect', '  redir https://acme.com{uri} 308', '}'].join('\n'));
    expect(out.match(/request_header X-Request-Id/g)).toHaveLength(1);
  });
});
