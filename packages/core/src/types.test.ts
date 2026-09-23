import { describe, expect, it } from 'bun:test';
import {
  EXPOSE_LABEL,
  EXPOSE_MODES,
  BUILDER_ENABLE_HINT,
  NODE_BUILDER_LABEL,
  NODE_DATABASE_LABEL,
  NODE_PROFILE_VALUES,
  buildGateAllows,
  isBuilderCapable,
  parseBuildOverride,
  NODE_STORAGE_LABEL,
  parseExposeMode,
  parseNodeProfile,
  profileToLabels,
  NODE_EXEC_LABEL,
  NODE_SHELL_LABEL,
  execGateAllows,
  isExecCapable,
  isNodeShellCapable,
  nodeShellGateAllows,
  parseCapabilityOverride,
} from './types';

describe('parseExposeMode — the `swarmy.expose` label codec', () => {
  it('accepts every declared mode verbatim', () => {
    for (const mode of EXPOSE_MODES) {
      expect(parseExposeMode(mode)).toBe(mode);
    }
  });

  it('absent / unknown / junk values → null (undeclared)', () => {
    expect(parseExposeMode(undefined)).toBeNull();
    expect(parseExposeMode(null)).toBeNull();
    expect(parseExposeMode('')).toBeNull();
    expect(parseExposeMode('Public')).toBeNull();
    expect(parseExposeMode('internal')).toBeNull();
  });

  it('label constant is the documented service label', () => {
    expect(EXPOSE_LABEL).toBe('swarmy.expose');
  });
});

describe('install profiles (WS7) — profileToLabels + parseNodeProfile', () => {
  it('bundles exactly the documented labels per profile', () => {
    expect(profileToLabels('edge')).toEqual({ 'swarmy.node.ingress': 'true' });
    expect(profileToLabels('storage')).toEqual({ [NODE_STORAGE_LABEL]: 'true' });
    expect(profileToLabels('database')).toEqual({ [NODE_DATABASE_LABEL]: 'true' });
  });

  it('default, private-mesh, and absent profiles bundle nothing', () => {
    expect(profileToLabels('default')).toEqual({});
    expect(profileToLabels('private-mesh')).toEqual({});
    expect(profileToLabels(null)).toEqual({});
    expect(profileToLabels(undefined)).toEqual({});
  });

  it('parseNodeProfile round-trips every value and rejects junk', () => {
    for (const p of NODE_PROFILE_VALUES) expect(parseNodeProfile(p)).toBe(p);
    expect(parseNodeProfile(null)).toBeNull();
    expect(parseNodeProfile('Edge')).toBeNull();
    expect(parseNodeProfile('manager')).toBeNull();
  });

  it('data-role label constants are the documented node labels', () => {
    expect(NODE_STORAGE_LABEL).toBe('swarmy.node.storage');
    expect(NODE_DATABASE_LABEL).toBe('swarmy.node.database');
  });
});

describe('builder capability', () => {
  it('parses SWARMY_ALLOW_BUILD into an explicit override (unset = none)', () => {
    expect(parseBuildOverride(undefined)).toBeUndefined();
    expect(parseBuildOverride('')).toBeUndefined();
    expect(parseBuildOverride('true')).toBe('allow');
    expect(parseBuildOverride('1')).toBe('allow');
    expect(parseBuildOverride('false')).toBe('deny');
    expect(parseBuildOverride('garbage')).toBeUndefined();
  });

  it('role label (new + legacy spelling) makes a node builder-capable; override wins both ways', () => {
    expect(isBuilderCapable({ [NODE_BUILDER_LABEL]: 'true' }, undefined)).toBe(true);
    expect(isBuilderCapable({ 'swarmy.role': 'builder' }, undefined)).toBe(true);
    expect(isBuilderCapable({ [NODE_BUILDER_LABEL]: '' }, undefined)).toBe(false);
    expect(isBuilderCapable(undefined, 'allow')).toBe(true);
    expect(isBuilderCapable({ [NODE_BUILDER_LABEL]: 'true' }, 'deny')).toBe(false);
  });

  it('agent gate: local override wins, else the controller assertion, absent = off', () => {
    expect(buildGateAllows(undefined, undefined)).toBe(false);
    expect(buildGateAllows(undefined, true)).toBe(true);
    expect(buildGateAllows('deny', true)).toBe(false);
    expect(buildGateAllows('allow', undefined)).toBe(true);
    expect(BUILDER_ENABLE_HINT).toContain('Builder');
  });
});

describe('terminal capabilities — container exec (default ON)', () => {
  it('parses SWARMY_ALLOW_EXEC tri-state (unset = no override)', () => {
    expect(parseCapabilityOverride(undefined)).toBeUndefined();
    expect(parseCapabilityOverride('true')).toBe('allow');
    expect(parseCapabilityOverride('false')).toBe('deny');
  });

  it('controller: exec allowed unless the node label turns it off; env override wins both ways', () => {
    expect(NODE_EXEC_LABEL).toBe('swarmy.node.exec');
    expect(isExecCapable(undefined, undefined)).toBe(true);
    expect(isExecCapable({}, undefined)).toBe(true);
    expect(isExecCapable({ [NODE_EXEC_LABEL]: 'true' }, undefined)).toBe(true);
    expect(isExecCapable({ [NODE_EXEC_LABEL]: '' }, undefined)).toBe(true);
    expect(isExecCapable({ [NODE_EXEC_LABEL]: 'false' }, undefined)).toBe(false);
    expect(isExecCapable({ [NODE_EXEC_LABEL]: 'false' }, 'allow')).toBe(true);
    expect(isExecCapable({}, 'deny')).toBe(false);
  });

  it('agent gate truth table: env deny vetoes, env allow forces, else assertion (absent = allowed)', () => {
    const rows: [ReturnType<typeof parseCapabilityOverride>, boolean | undefined, boolean][] = [
      [undefined, undefined, true],
      [undefined, true, true],
      [undefined, false, false],
      ['allow', undefined, true],
      ['allow', false, true],
      ['deny', undefined, false],
      ['deny', true, false],
    ];
    for (const [o, c, want] of rows) expect(execGateAllows(o, c)).toBe(want);
  });
});

describe('terminal capabilities — host shell (default OFF)', () => {
  it('controller: only the swarmy.node.shell=true label enables; env deny vetoes; env allow does NOT force', () => {
    expect(NODE_SHELL_LABEL).toBe('swarmy.node.shell');
    expect(isNodeShellCapable(undefined, undefined)).toBe(false);
    expect(isNodeShellCapable({ [NODE_SHELL_LABEL]: '' }, undefined)).toBe(false);
    expect(isNodeShellCapable({ [NODE_SHELL_LABEL]: 'true' }, undefined)).toBe(true);
    expect(isNodeShellCapable({ [NODE_SHELL_LABEL]: 'true' }, 'deny')).toBe(false);
    expect(isNodeShellCapable({}, 'allow')).toBe(false);
    expect(isNodeShellCapable({ [NODE_SHELL_LABEL]: 'true' }, 'allow')).toBe(true);
  });

  it('agent gate truth table: needs the controller assertion AND env not false', () => {
    const rows: [ReturnType<typeof parseCapabilityOverride>, boolean | undefined, boolean][] = [
      [undefined, undefined, false],
      [undefined, false, false],
      [undefined, true, true],
      ['allow', undefined, false],
      ['allow', false, false],
      ['allow', true, true],
      ['deny', true, false],
      ['deny', undefined, false],
    ];
    for (const [o, c, want] of rows) expect(nodeShellGateAllows(o, c)).toBe(want);
  });
});
