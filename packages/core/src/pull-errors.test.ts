import { describe, expect, test } from 'bun:test';
import { CACHE_FAILURE_CAUSE, HUB_RATE_LIMIT_CAUSE, explainImagePullError } from './pull-errors';

describe('explainImagePullError', () => {
  test.each([
    'toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit',
    'Error response from daemon: 429 Too Many Requests',
    'pull nginx:latest: toomanyrequests: too many requests',
  ])('Hub rate limit: %p', (m) => {
    const out = explainImagePullError(m);
    expect(out.startsWith(`${HUB_RATE_LIMIT_CAUSE}:`)).toBe(true);
    expect(out).toContain('CI → Registry');
    expect(out.endsWith(m)).toBe(true);
  });

  test.each([
    'Get "http://localhost:5001/v2/library/nginx/manifests/latest": received unexpected HTTP status: 500 Internal Server Error',
    'error pulling image configuration: download failed after attempts=6: received unexpected HTTP status: 500 Internal Server Error',
    'swarmy-registry-cache: 502 Bad Gateway',
  ])('cache 5xx: %p', (m) => {
    expect(explainImagePullError(m).startsWith(`${CACHE_FAILURE_CAUSE}:`)).toBe(true);
  });

  test('unrelated errors pass through; explaining is idempotent', () => {
    for (const m of ['No such image: x:1', 'manifest unknown', 'no space left on device', '']) {
      expect(explainImagePullError(m)).toBe(m);
    }
    const once = explainImagePullError('toomanyrequests');
    expect(explainImagePullError(once)).toBe(once);
  });
});

describe('surfaced on the service', () => {
  test('buildInventory explains a task lastError', async () => {
    const { buildInventory } = await import('./inventory');
    const inv = buildInventory(
      [
        {
          id: 's1',
          name: 'web',
          image: 'nginx',
          labels: {},
          replicas: { desired: 1, running: 0 },
          taskHealth: { recentFailures: 1, starting: false, lastError: 'toomanyrequests: rate limit' },
        } as never,
      ],
      [],
    );
    expect(inv.services[0]!.lastError?.startsWith(HUB_RATE_LIMIT_CAUSE)).toBe(true);
  });
});
