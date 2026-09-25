import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '../types';
import { appAuthVerifyPath } from '../app-auth';
import { buildCaddyfile } from './caddyfile';

/**
 * RUM injection goldens (dev-platform epic §5 + §7). A route carrying `rum`
 * gets the `swarmy_rum` directive around its proxy, and its host gets the
 * first-party `/_swarmy/*` → controller `/_rum/*` handle. Routes without it
 * render byte-identically to before.
 */

const CONTROLLER = 'swarmy_controller:3021';
const TOKEN = 'v1.eyJvIjoib3JnXzEifQ.c2ln';

function cfg(domains: Record<string, unknown>[], global: Record<string, unknown> = {}): IngressConfig {
  return IngressConfigSchema.parse({ driver: 'caddy', orgId: 'org_1', domains, globalOptions: global });
}

const analytics = { upstream: CONTROLLER, token: TOKEN, mode: 'analytics' };

describe('caddy RUM render', () => {
  it('analytics mode: order line, host handle, directive around the proxy', () => {
    const out = buildCaddyfile(cfg([{ domain: 'app.example.com', service: 'web', port: 3000, rum: analytics }]));
    expect(out).toBe(`{
  order swarmy_rum before rewrite
}

app.example.com {
  # swarmy RUM (analytics / replay): first-party script + ingest
  handle_path /_swarmy/* {
    rewrite * /_rum{uri}
    reverse_proxy swarmy_controller:3021
  }
  handle {
    swarmy_rum {
      attr data-app v1.eyJvIjoib3JnXzEifQ.c2ln
      attr data-mode analytics
    }
    reverse_proxy web:3000 {
      stream_close_delay 5m
    }
  }
}
`);
  });

  it('identified + replay + tracing: span attribute, server timing, replay knobs', () => {
    const out = buildCaddyfile(
      cfg(
        [
          {
            domain: 'shop.example.com',
            service: 'web',
            port: 8080,
            rum: {
              ...analytics,
              mode: 'identified',
              replaySampleRate: 0.25,
              consent: 'hook',
              maskAllText: true,
              csp: 'skip',
            },
          },
        ],
        { tracing: true },
      ),
    );
    expect(out).toBe(`{
  order tracing first
  order swarmy_rum before rewrite
}

shop.example.com {
  tracing {
    span swarmy-edge
    span_attributes {
      swarmy.session_id {http.request.header.Swarmy-Session}
    }
  }
  # swarmy RUM (analytics / replay): first-party script + ingest
  handle_path /_swarmy/* {
    rewrite * /_rum{uri}
    reverse_proxy swarmy_controller:3021
  }
  # Replays render in the swarmy dashboard: let it load this app's fonts (CORS-gated).
  @swarmy_replay_fonts path *.woff2 *.woff *.ttf *.otf *.eot
  header @swarmy_replay_fonts ?Access-Control-Allow-Origin *
  handle {
    swarmy_rum {
      attr data-app v1.eyJvIjoib3JnXzEifQ.c2ln
      attr data-mode identified
      attr data-replay 0.25
      attr data-consent hook
      attr data-mask all
      csp skip
      server_timing
    }
    reverse_proxy web:8080 {
      stream_close_delay 5m
    }
  }
}
`);
  });

  it('per-route: only the opted-in path injects; the host handle is shared', () => {
    const out = buildCaddyfile(
      cfg([
        { domain: 'mixed.example.com', pathPrefix: '/', service: 'web', port: 3000, rum: analytics },
        { domain: 'mixed.example.com', pathPrefix: '/api', service: 'api', port: 4000 },
      ]),
    );
    expect(out).toContain('  handle_path /_swarmy/* {');
    const api = out.slice(out.indexOf('handle /api*'), out.indexOf('handle {'));
    expect(api).not.toContain('swarmy_rum');
    const root = out.slice(out.indexOf('  handle {'));
    expect(root).toContain('swarmy_rum {');
    // The /_swarmy handle precedes every route handle.
    expect(out.indexOf('/_swarmy/*')).toBeLessThan(out.indexOf('handle /api*'));
  });

  it('login-protected identified route: data-uid from the identity header, after forward_auth', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'app.example.com',
          service: 'web',
          port: 3000,
          auth: { upstream: CONTROLLER, verifyPath: appAuthVerifyPath('org_1') },
          rum: { ...analytics, mode: 'identified' },
        },
      ]),
    );
    expect(out).toContain('      attr data-uid {http.request.header.X-Swarmy-User}');
    expect(out.indexOf('forward_auth')).toBeLessThan(out.indexOf('swarmy_rum {'));
    expect(out.indexOf('swarmy_rum {')).toBeLessThan(out.indexOf('reverse_proxy web:3000'));
  });

  it('unprotected identified route never renders data-uid (the header would be spoofable)', () => {
    const out = buildCaddyfile(cfg([{ domain: 'a.example.com', service: 'web', port: 3000, rum: { ...analytics, mode: 'identified' } }]));
    expect(out).not.toContain('data-uid');
  });

  it('analytics mode never carries session plumbing (no span attribute, no replay attrs)', () => {
    const out = buildCaddyfile(
      cfg([{ domain: 'a.example.com', service: 'web', port: 3000, rum: { ...analytics, replaySampleRate: 1, consent: 'cmp' } }], {
        tracing: true,
      }),
    );
    expect(out).not.toContain('span_attributes');
    expect(out).not.toContain('data-replay');
    expect(out).not.toContain('data-consent');
  });

  it('cold route: no injection, no order line (the body is the wake page)', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'a.example.com',
          service: 'web',
          port: 3000,
          rum: analytics,
          cold: { upstream: CONTROLLER, wakePath: '/_wake/web' },
        },
      ]),
    );
    expect(out).not.toContain('swarmy_rum');
    expect(out).not.toContain('/_swarmy/');
  });

  it('with a cached route, the RUM order line precedes the cache order (injector wraps cache)', () => {
    const out = buildCaddyfile(
      cfg([
        { domain: 'a.example.com', service: 'web', port: 3000, rum: analytics, protection: { cache: { ttlSeconds: 60 } } },
      ]),
    );
    expect(out.indexOf('order swarmy_rum before rewrite')).toBeLessThan(out.indexOf('order cache before rewrite'));
  });

  it('without rum, output is byte-identical to the legacy render', () => {
    const out = buildCaddyfile(cfg([{ domain: 'a.example.com', service: 'web', port: 3000 }]));
    expect(out).toBe(`a.example.com {
  reverse_proxy web:3000 {
    stream_close_delay 5m
  }
}
`);
  });

  it('rejects a token that could break out of the Caddyfile token', () => {
    expect(() => cfg([{ domain: 'a.example.com', service: 'web', port: 3000, rum: { ...analytics, token: 'x y}' } }])).toThrow();
  });
});
