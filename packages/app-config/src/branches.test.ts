import { describe, expect, it } from 'bun:test';
import {
  branchMatchesAny,
  branchPreviewId,
  branchSlug,
  isBranchPreviewId,
  matchBranchPattern,
} from './branches';
import { toDesired } from './desired';
import { FULL_EXAMPLE, MINIMAL_EXAMPLE } from './examples';
import { parseAppConfig } from './parse';
import { emptyLive, planApp } from './plan';

describe('branch patterns', () => {
  it('* stays inside a path segment, ** crosses them', () => {
    expect(matchBranchPattern('feature/*', 'feature/login')).toBe(true);
    expect(matchBranchPattern('feature/*', 'feature/a/b')).toBe(false);
    expect(matchBranchPattern('feature/**', 'feature/a/b')).toBe(true);
    expect(matchBranchPattern('release-?', 'release-2')).toBe(true);
    expect(matchBranchPattern('main', 'main-2')).toBe(false);
    expect(matchBranchPattern('fix.x', 'fixyx')).toBe(false); // dots are literal
    expect(branchMatchesAny(['feature/*', 'hotfix/*'], 'hotfix/db')).toBe(true);
  });

  it('slugs and ids are stable and DNS/stack safe', () => {
    expect(branchSlug('feature/Login_Page')).toBe('feature-login-page');
    const long = branchSlug('feature/a-really-long-branch-name-that-keeps-going');
    expect(long.length).toBeLessThanOrEqual(24);
    expect(long).toMatch(/^[a-z0-9-]+$/);
    expect(branchPreviewId('feature/x')).toBe(branchPreviewId('feature/x'));
    expect(isBranchPreviewId(branchPreviewId('feature/x'))).toBe(true);
    expect(isBranchPreviewId(42)).toBe(false);
  });
});

describe('branch previews + previews with data', () => {
  const text = FULL_EXAMPLE.replace(
    'previews:\n  enabled: true\n  ttl: 48h\n',
    'previews:\n  enabled: true\n  ttl: 48h\n  branches: [feature/*]\n  data: { from: production, scrub: db/scrub.sql }\n',
  );
  const cfg = () => {
    const r = parseAppConfig(text);
    if (!r.config) throw new Error(JSON.stringify(r.issues));
    return r.config;
  };

  it('a branch preview is its own stack with branch-named hosts', () => {
    const d = toDesired(cfg(), {
      preview: {
        pr: branchPreviewId('feature/login'),
        branch: 'feature/login',
        baseDomain: 'p.example.com',
      },
    });
    expect(d.stack).toBe('orders-b-feature-login');
    expect(d.preview).toEqual({ pr: branchPreviewId('feature/login'), branch: 'feature/login' });
    expect(d.routes.map((r) => r.host)).toEqual([
      'feature-login-admin.p.example.com',
      'feature-login.p.example.com',
    ]);
  });

  it('previews.data makes the preview postgres a scrubbed COPY, said in plain words', () => {
    const d = toDesired(cfg(), { preview: { pr: 7, baseDomain: 'p.example.com' } });
    expect(d.previewData).toEqual({
      fromStack: 'orders',
      fromEnvironment: 'production',
      scrub: 'db/scrub.sql',
    });
    const create = planApp(d, emptyLive(d.stack)).actions.find(
      (a) => a.id === 'resource.create:db',
    );
    expect(create?.reason).toBe(
      'create postgres 16 "db" (single) — a COPY of production\'s latest backup, scrubbed by db/scrub.sql; destroyed with the preview',
    );
    expect(toDesired(cfg()).previewData).toBeUndefined(); // never outside a preview
  });

  it('validates previews.data and branch patterns', () => {
    const bad = parseAppConfig(
      MINIMAL_EXAMPLE +
        'previews: { enabled: true, resources: shared, branches: ["feat ure/*"], data: { from: qa } }\n',
    );
    expect(bad.issues.filter((i) => i.severity === 'error').map((i) => i.code)).toEqual([
      'previews/data-from',
      'previews/data-shared',
      'previews/branch-pattern',
    ]);
  });
});
