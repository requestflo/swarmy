import { describe, expect, it } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import {
  branchPreviewNumber,
  buildPreviewSpecs,
  parsePreviewMeta,
  parsePreviewSettings,
  parsePrWebhookEvent,
  previewExpiresAt,
  previewHost,
  previewLabels,
  previewStackName,
  repoShort,
  rewritePreviewEnv,
  selectExpiredPreviews,
  type PreviewMeta,
} from './previews.service';

const HOUR = 60 * 60 * 1000;

function meta(over: Partial<PreviewMeta> = {}): PreviewMeta {
  return {
    repo: 'shop',
    pr: 142,
    branch: 'feat/cart',
    url: 'https://pr-142.preview.example.com',
    createdAt: '2026-07-01T10:00:00.000Z',
    ttlHours: 72,
    ...over,
  };
}

describe('names — repoShort / previewStackName / previewHost', () => {
  it('derives a short slug from common git URLs', () => {
    expect(repoShort('https://github.com/northwind/shop.git')).toBe('shop');
    expect(repoShort('git@github.com:northwind/Shop-Front.git')).toBe('shop-front');
    expect(repoShort('https://gitlab.com/a/b/checkout')).toBe('checkout');
  });

  it('sanitizes, truncates and never returns empty', () => {
    expect(repoShort('https://github.com/x/My_Very Long!!Repo-Name-Overflowing.git')).toBe(
      'my-very-long-repo-na',
    );
    expect(repoShort('')).toBe('app');
  });

  it('builds pr<N>-<short> stacks and pr-<N> hosts', () => {
    expect(previewStackName(142, 'https://github.com/northwind/shop.git')).toBe('pr142-shop');
    expect(previewHost(142, 'preview.example.com')).toBe('pr-142.preview.example.com');
  });

  it('pseudo-PR numbers are stable, in range, branch-dependent', () => {
    const a = branchPreviewNumber('feat/cart');
    expect(a).toBe(branchPreviewNumber('feat/cart'));
    expect(a).toBeGreaterThanOrEqual(90_000);
    expect(a).toBeLessThan(100_000);
    expect(branchPreviewNumber('feat/other')).not.toBe(a);
  });
});

describe('label codec — previewLabels ⇄ parsePreviewMeta', () => {
  it('round-trips the full meta', () => {
    const m = meta();
    expect(parsePreviewMeta(previewLabels(m))).toEqual(m);
  });

  it('omits the url label when null and parses it back as null', () => {
    const labels = previewLabels(meta({ url: null }));
    expect('swarmy.preview.url' in labels).toBe(false);
    expect(parsePreviewMeta(labels)?.url).toBeNull();
  });

  it('is not a preview without a parseable PR number', () => {
    expect(parsePreviewMeta({})).toBeNull();
    expect(parsePreviewMeta({ 'swarmy.preview.pr': 'nope' })).toBeNull();
    expect(parsePreviewMeta({ 'swarmy.preview.pr': '0' })).toBeNull();
  });

  it('degrades garbled createdAt/ttl to "no TTL" instead of instant expiry', () => {
    const m = parsePreviewMeta({
      'swarmy.preview.pr': '7',
      'swarmy.preview.createdAt': 'garbage',
      'swarmy.preview.ttlHours': '-3',
    });
    expect(m).not.toBeNull();
    expect(m!.createdAt).toBeNull();
    expect(m!.ttlHours).toBe(0);
    expect(previewExpiresAt(m!)).toBeNull();
  });
});

describe('TTL selection — previewExpiresAt / selectExpiredPreviews', () => {
  it('expires exactly createdAt + ttlHours', () => {
    const m = meta({ createdAt: '2026-07-01T10:00:00.000Z', ttlHours: 2 });
    expect(previewExpiresAt(m)?.toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });

  it('ttlHours 0 never expires', () => {
    expect(previewExpiresAt(meta({ ttlHours: 0 }))).toBeNull();
  });

  it('selects only past-TTL stacks at now', () => {
    const now = new Date('2026-07-02T00:00:00.000Z');
    const mk = (stack: string, ageHours: number, ttl: number) => ({
      stack,
      meta: meta({ createdAt: new Date(now.getTime() - ageHours * HOUR).toISOString(), ttlHours: ttl }),
    });
    const expired = selectExpiredPreviews(
      [mk('pr1-shop', 80, 72), mk('pr2-shop', 10, 72), mk('pr3-shop', 500, 0), mk('pr4-shop', 72, 72)],
      now,
    );
    expect(expired).toEqual(['pr1-shop', 'pr4-shop']);
  });
});

describe('settings — parsePreviewSettings', () => {
  it('defaults for null / non-object json', () => {
    expect(parsePreviewSettings(null)).toEqual({
      enabled: false,
      baseDomain: '',
      ttlHours: 72,
      teardownOnClose: true,
    });
    expect(parsePreviewSettings('x')).toEqual(parsePreviewSettings(undefined));
  });

  it('parses a saved blob and clamps a bad ttl back to the default', () => {
    expect(
      parsePreviewSettings({ enabled: true, baseDomain: 'Preview.Example.com ', ttlHours: 24, teardownOnClose: false }),
    ).toEqual({ enabled: true, baseDomain: 'preview.example.com', ttlHours: 24, teardownOnClose: false });
    expect(parsePreviewSettings({ enabled: true, ttlHours: 99_999 }).ttlHours).toBe(72);
  });
});

describe('spec transform — buildPreviewSpecs / rewritePreviewEnv', () => {
  const compose: ServiceSpec[] = [
    {
      name: 'web',
      image: 'reg:5000/northwind-shop:main',
      mode: { replicated: { replicas: 3 } },
      env: { DATABASE_URL: 'postgres://user:pw@db:5432/shop', API: 'http://web:3000' },
      ports: [{ target: 3000, published: 8080, protocol: 'tcp', mode: 'ingress' }],
    },
    { name: 'db', image: 'postgres:16', mode: { replicated: { replicas: 1 } } },
  ];

  it('rewrites whole-token short-name refs in env values only', () => {
    const out = rewritePreviewEnv(
      { A: 'postgres://db:5432/x', B: 'dbx://db2', C: 'no-match' },
      ['db'],
      'pr142-shop',
    );
    expect(out.A).toBe('postgres://pr142-shop_db:5432/x');
    expect(out.B).toBe('dbx://db2'); // `db` inside `dbx`/`db2` is not a token
    expect(out.C).toBe('no-match');
  });

  it('prefixes names, swaps the target image, clamps replicas, drops publishing', () => {
    const specs = buildPreviewSpecs(compose, {
      stackName: 'pr142-shop',
      meta: meta(),
      image: 'reg:5000/northwind-shop@sha256:abc',
      targetShort: 'web',
      host: 'pr-142.preview.example.com',
    });
    expect(specs.map((s) => s.name)).toEqual(['pr142-shop_web', 'pr142-shop_db']);
    expect(specs[0]!.image).toBe('reg:5000/northwind-shop@sha256:abc');
    expect(specs[1]!.image).toBe('postgres:16'); // non-target keeps its image
    expect(specs[0]!.mode).toEqual({ replicated: { replicas: 1 } });
    // Private-by-default: no published ports (the pr-<N> route is the front door);
    // everything rides the shared attachable overlay the ingress proxy is on.
    expect(specs[0]!.ports).toBeUndefined();
    expect(specs.every((s) => s.networks?.includes('swarmy'))).toBe(true);
  });

  it('stamps stack + preview labels on every service, route label on the target', () => {
    const specs = buildPreviewSpecs(compose, {
      stackName: 'pr142-shop',
      meta: meta(),
      image: 'img@sha256:abc',
      targetShort: 'web',
      host: 'pr-142.preview.example.com',
    });
    for (const s of specs) {
      expect(s.labels?.['com.docker.stack.namespace']).toBe('pr142-shop');
      expect(s.labels?.['swarmy.preview.pr']).toBe('142');
      expect(s.labels?.['swarmy.managed']).toBe('true');
    }
    const routes = JSON.parse(specs[0]!.labels!['swarmy.ingress.routes']!) as unknown[];
    expect(routes).toEqual([{ host: 'pr-142.preview.example.com', port: 3000, tls: 'auto' }]);
    expect(specs[0]!.labels?.['swarmy.ingress']).toBe('true');
    expect(specs[1]!.labels?.['swarmy.ingress.routes']).toBeUndefined();
  });

  it('no host → no route label; env carries PREVIEW_* and rewritten refs', () => {
    const specs = buildPreviewSpecs(compose, {
      stackName: 'pr142-shop',
      meta: meta({ url: null }),
      image: 'img@sha256:abc',
      targetShort: 'web',
      host: null,
    });
    expect(specs[0]!.labels?.['swarmy.ingress.routes']).toBeUndefined();
    expect(specs[0]!.env?.PREVIEW).toBe('true');
    expect(specs[0]!.env?.PREVIEW_PR).toBe('142');
    expect(specs[0]!.env?.PREVIEW_URL).toBeUndefined();
    expect(specs[0]!.env?.DATABASE_URL).toBe('postgres://user:pw@pr142-shop_db:5432/shop');
  });

  it('unknown target falls back to the first spec', () => {
    const specs = buildPreviewSpecs(compose, {
      stackName: 'pr9-shop',
      meta: meta({ pr: 9 }),
      image: 'img:pr',
      targetShort: null,
      host: null,
    });
    expect(specs[0]!.image).toBe('img:pr');
  });
});

describe('provider PR webhook parsing — parsePrWebhookEvent', () => {
  const gh = (action: string) => ({
    action,
    number: 142,
    pull_request: { number: 142, head: { ref: 'feat/cart', sha: 'abc123' } },
  });

  it('github: opened/reopened/synchronize/closed map through; others ignored', () => {
    expect(parsePrWebhookEvent('github', 'pull_request', gh('opened'))).toEqual({
      action: 'opened',
      prNumber: 142,
      branch: 'feat/cart',
      commit: 'abc123',
    });
    expect(parsePrWebhookEvent('github', 'pull_request', gh('reopened'))?.action).toBe('opened');
    expect(parsePrWebhookEvent('github', 'pull_request', gh('synchronize'))?.action).toBe('synchronize');
    expect(parsePrWebhookEvent('github', 'pull_request', gh('closed'))?.action).toBe('closed');
    expect(parsePrWebhookEvent('github', 'pull_request', gh('labeled'))).toBeNull();
    expect(parsePrWebhookEvent('github', 'push', { ref: 'refs/heads/main' })).toBeNull();
  });

  it('gitlab: MR open/update/close/merge map through; pushes ignored', () => {
    const gl = (action: string) => ({
      object_kind: 'merge_request',
      object_attributes: { iid: 7, action, source_branch: 'fix/tax', last_commit: { id: 'deadbeef' } },
    });
    expect(parsePrWebhookEvent('gitlab', 'Merge Request Hook', gl('open'))).toEqual({
      action: 'opened',
      prNumber: 7,
      branch: 'fix/tax',
      commit: 'deadbeef',
    });
    expect(parsePrWebhookEvent('gitlab', 'Merge Request Hook', gl('update'))?.action).toBe('synchronize');
    expect(parsePrWebhookEvent('gitlab', 'Merge Request Hook', gl('merge'))?.action).toBe('closed');
    expect(parsePrWebhookEvent('gitlab', 'Merge Request Hook', gl('approved'))).toBeNull();
    expect(parsePrWebhookEvent('gitlab', 'Push Hook', { object_kind: 'push' })).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(parsePrWebhookEvent('github', 'pull_request', null)).toBeNull();
    expect(parsePrWebhookEvent('github', 'pull_request', { action: 'opened' })).toBeNull();
    expect(
      parsePrWebhookEvent('gitlab', 'Merge Request Hook', { object_kind: 'merge_request', object_attributes: {} }),
    ).toBeNull();
  });
});
