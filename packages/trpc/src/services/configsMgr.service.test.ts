import { describe, expect, it } from 'bun:test';
import type { SwarmResourceInfo } from '@swarmy/core/protocol';
import {
  configRefsFor,
  defaultConfigMountPath,
  groupConfigs,
  isValidConfigFamily,
  nextConfigVersion,
  parsePhysicalConfigName,
  physicalConfigName,
} from './configsMgr.service';

describe('physical name codec', () => {
  it('round-trips <family>__v<n>', () => {
    expect(physicalConfigName('caddy-snippet', 1)).toBe('caddy-snippet__v1');
    expect(parsePhysicalConfigName('caddy-snippet__v1')).toEqual({
      family: 'caddy-snippet',
      version: 1,
    });
    expect(parsePhysicalConfigName(physicalConfigName('a.b-c_d', 42))).toEqual({
      family: 'a.b-c_d',
      version: 42,
    });
  });

  it('parses greedily so an inner __v stays in the family part', () => {
    expect(parsePhysicalConfigName('FOO__v2__v3')).toEqual({ family: 'FOO__v2', version: 3 });
  });

  it('rejects unmanaged names', () => {
    expect(parsePhysicalConfigName('plain-config')).toBeNull();
    expect(parsePhysicalConfigName('X__v')).toBeNull();
    expect(parsePhysicalConfigName('X__v0')).toBeNull();
    expect(parsePhysicalConfigName('__v3')).toBeNull(); // empty family
    expect(parsePhysicalConfigName('X__vNaN')).toBeNull();
  });
});

describe('family name validation', () => {
  it('accepts file/env-style names', () => {
    for (const n of ['caddy-snippet', 'app-config', 'a', 'a.b-c_D9']) {
      expect(isValidConfigFamily(n)).toBe(true);
    }
  });

  it('rejects codec-breaking, malformed and oversized names', () => {
    expect(isValidConfigFamily('FOO__v2')).toBe(false); // would break parsing
    expect(isValidConfigFamily('')).toBe(false);
    expect(isValidConfigFamily('-leading')).toBe(false);
    expect(isValidConfigFamily('has space')).toBe(false);
    expect(isValidConfigFamily('has/slash')).toBe(false);
    expect(isValidConfigFamily('x'.repeat(57))).toBe(false);
    expect(isValidConfigFamily('x'.repeat(56))).toBe(true);
  });
});

describe('version math', () => {
  it('starts at 1 and increments past the max (gaps ok)', () => {
    expect(nextConfigVersion([])).toBe(1);
    expect(nextConfigVersion([1])).toBe(2);
    expect(nextConfigVersion([3, 1])).toBe(4); // v2 pruned — never reuse
  });

  it('ignores junk versions', () => {
    expect(nextConfigVersion([Number.NaN, -5, 2.5, 2])).toBe(3);
  });
});

describe('config ref codec (redeploy rebuilds)', () => {
  it('managed names target the family mount path; unmanaged untouched', () => {
    const mounts = new Map([['caddy-snippet', '/etc/caddy/snippets/common.caddy']]);
    expect(configRefsFor(['caddy-snippet__v3', 'hand-made'], mounts)).toEqual([
      { source: 'caddy-snippet__v3', target: '/etc/caddy/snippets/common.caddy' },
      { source: 'hand-made' },
    ]);
  });

  it('falls back to the /<family> default when the mount map misses', () => {
    expect(configRefsFor(['app-config__v1'], new Map())).toEqual([
      { source: 'app-config__v1', target: '/app-config' },
    ]);
    expect(defaultConfigMountPath('app-config')).toBe('/app-config');
  });
});

describe('groupConfigs (labels → families + orphans)', () => {
  const cfg = (
    name: string,
    labels: Record<string, string>,
    createdAt = 1_000,
  ): SwarmResourceInfo => ({ id: `id-${name}`, name, createdAt, labels });

  const fam = (
    family: string,
    version: number,
    org = 'org-1',
    mountPath?: string,
  ): Record<string, string> => ({
    'swarmy.config.family': family,
    'swarmy.config.version': String(version),
    'swarmy.config.org': org,
    ...(mountPath ? { 'swarmy.config.path': mountPath } : {}),
  });

  it('groups by family label, newest version first, mount path from newest', () => {
    const { families, orphans } = groupConfigs(
      [
        cfg('K__v1', fam('K', 1, 'org-1', '/old/path'), 100),
        cfg('K__v3', fam('K', 3, 'org-1', '/etc/k.conf'), 300),
        cfg('K__v2', fam('K', 2, 'org-1', '/etc/k.conf'), 200),
      ],
      'org-1',
    );
    expect(orphans).toEqual([]);
    expect(families).toHaveLength(1);
    expect(families[0]!.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(families[0]!.versions[0]!.createdAt).toBe(300);
    expect(families[0]!.mountPath).toBe('/etc/k.conf');
  });

  it('defaults the mount path when no label carries one', () => {
    const { families } = groupConfigs([cfg('K__v1', fam('K', 1))], 'org-1');
    expect(families[0]!.mountPath).toBe('/K');
  });

  it('scopes by org label and falls back to name-parsed versions', () => {
    const { families } = groupConfigs(
      [
        cfg('K__v2', { 'swarmy.config.family': 'K' }), // no version label → parse name
        cfg('OTHER__v1', fam('OTHER', 1, 'org-2')), // different org → hidden
      ],
      'org-1',
    );
    expect(families).toHaveLength(1);
    expect(families[0]!.versions[0]!.version).toBe(2);
  });

  it('orphans = configs with NO swarmy label; other swarmy-managed hidden', () => {
    const { families, orphans } = groupConfigs(
      [
        cfg('hand-made-conf', {}),
        cfg('caddy-rendered', { 'swarmy.ingress.rendered': 'true' }),
      ],
      'org-1',
    );
    expect(families).toEqual([]);
    expect(orphans.map((o) => o.name)).toEqual(['hand-made-conf']);
  });
});
