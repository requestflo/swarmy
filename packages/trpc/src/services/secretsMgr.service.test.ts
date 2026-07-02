import { describe, expect, it } from 'bun:test';
import type { SwarmResourceInfo } from '@swarmy/core/protocol';
import {
  groupSecrets,
  isValidSecretFamily,
  nextSecretVersion,
  parsePhysicalSecretName,
  physicalSecretName,
  secretMountPath,
  secretRefsFor,
} from './secretsMgr.service';

describe('physical name codec', () => {
  it('round-trips <family>__v<n>', () => {
    expect(physicalSecretName('DATABASE_URL', 1)).toBe('DATABASE_URL__v1');
    expect(parsePhysicalSecretName('DATABASE_URL__v1')).toEqual({
      family: 'DATABASE_URL',
      version: 1,
    });
    expect(parsePhysicalSecretName(physicalSecretName('a.b-c_d', 42))).toEqual({
      family: 'a.b-c_d',
      version: 42,
    });
  });

  it('parses greedily so an inner __v stays in the family part', () => {
    expect(parsePhysicalSecretName('FOO__v2__v3')).toEqual({ family: 'FOO__v2', version: 3 });
  });

  it('rejects unmanaged names', () => {
    expect(parsePhysicalSecretName('plain-secret')).toBeNull();
    expect(parsePhysicalSecretName('X__v')).toBeNull();
    expect(parsePhysicalSecretName('X__v0')).toBeNull();
    expect(parsePhysicalSecretName('__v3')).toBeNull(); // empty family
    expect(parsePhysicalSecretName('X__vNaN')).toBeNull();
  });
});

describe('family name validation', () => {
  it('accepts env-style names', () => {
    for (const n of ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'a', 'a.b-c_D9']) {
      expect(isValidSecretFamily(n)).toBe(true);
    }
  });

  it('rejects codec-breaking, malformed and oversized names', () => {
    expect(isValidSecretFamily('FOO__v2')).toBe(false); // would break parsing
    expect(isValidSecretFamily('')).toBe(false);
    expect(isValidSecretFamily('-leading')).toBe(false);
    expect(isValidSecretFamily('has space')).toBe(false);
    expect(isValidSecretFamily('has/slash')).toBe(false);
    expect(isValidSecretFamily('x'.repeat(57))).toBe(false);
    expect(isValidSecretFamily('x'.repeat(56))).toBe(true);
  });
});

describe('version math', () => {
  it('starts at 1 and increments past the max (gaps ok)', () => {
    expect(nextSecretVersion([])).toBe(1);
    expect(nextSecretVersion([1])).toBe(2);
    expect(nextSecretVersion([3, 1])).toBe(4); // v2 pruned — never reuse
  });

  it('ignores junk versions', () => {
    expect(nextSecretVersion([Number.NaN, -5, 2.5, 2])).toBe(3);
  });
});

describe('secret ref codec (redeploy rebuilds)', () => {
  it('managed names mount at the stable family target; others untouched', () => {
    expect(secretRefsFor(['DATABASE_URL__v3', 'legacy-token'])).toEqual([
      { source: 'DATABASE_URL__v3', target: 'DATABASE_URL' },
      { source: 'legacy-token' },
    ]);
    expect(secretMountPath('DATABASE_URL')).toBe('/run/secrets/DATABASE_URL');
  });
});

describe('groupSecrets (labels → families + orphans)', () => {
  const sec = (
    name: string,
    labels: Record<string, string>,
    createdAt = 1_000,
  ): SwarmResourceInfo => ({ id: `id-${name}`, name, createdAt, labels });

  const fam = (family: string, version: number, org = 'org-1'): Record<string, string> => ({
    'swarmy.secret.family': family,
    'swarmy.secret.version': String(version),
    'swarmy.secret.org': org,
  });

  it('groups by family label, newest version first', () => {
    const { families, orphans } = groupSecrets(
      [
        sec('K__v1', fam('K', 1), 100),
        sec('K__v3', fam('K', 3), 300),
        sec('K__v2', fam('K', 2), 200),
      ],
      'org-1',
    );
    expect(orphans).toEqual([]);
    expect(families).toHaveLength(1);
    expect(families[0]!.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(families[0]!.versions[0]!.createdAt).toBe(300);
  });

  it('scopes by org label and falls back to name-parsed versions', () => {
    const { families } = groupSecrets(
      [
        sec('K__v2', { 'swarmy.secret.family': 'K' }), // no version label → parse name
        sec('OTHER__v1', fam('OTHER', 1, 'org-2')), // different org → hidden
      ],
      'org-1',
    );
    expect(families).toHaveLength(1);
    expect(families[0]!.versions[0]!.version).toBe(2);
  });

  it('orphans = secrets with NO swarmy label; other swarmy-managed hidden', () => {
    const { families, orphans } = groupSecrets(
      [
        sec('hand-made-token', {}),
        sec('cache-pass', { 'swarmy.managed': 'true', 'swarmy.cache.cluster': 'main' }),
      ],
      'org-1',
    );
    expect(families).toEqual([]);
    expect(orphans.map((o) => o.name)).toEqual(['hand-made-token']);
  });
});
