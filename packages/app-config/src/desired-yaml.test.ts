import { describe, expect, it } from 'bun:test';
import { toDesired } from './desired';
import { desiredYaml } from './desired-yaml';
import { FULL_EXAMPLE, MINIMAL_EXAMPLE } from './examples';
import { parseAppConfig } from './parse';

const desired = (text: string) => {
  const r = parseAppConfig(text);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return toDesired(r.config);
};

describe('desiredYaml (board 26 YAML diff)', () => {
  it('renders the spec without signatures or build keys', () => {
    const d = desired(FULL_EXAMPLE);
    const text = desiredYaml(d)!;
    expect(d.services[0]!.sig).toBeTruthy();
    expect(text).not.toMatch(/^\s*sig:/m);
    expect(text).not.toMatch(/^\s*key:/m);
    expect(text).toContain('serviceName: orders_web');
    expect(text).toContain('DATABASE_URL: ${{ db.url }}');
  });

  it('keeps the unit order, so a source key stays where it was', () => {
    const text = desiredYaml(desired(MINIMAL_EXAMPLE))!;
    const lines = text.split('\n');
    const at = (s: string): number => lines.findIndex((l) => l.trim().startsWith(s));
    expect(at('serviceName:')).toBeLessThan(at('source:'));
    expect(at('source:')).toBeLessThan(at('port:'));
  });

  it('is stable: the same commit renders the same text, so an unchanged spec diffs empty', () => {
    expect(desiredYaml(desired(FULL_EXAMPLE))).toBe(desiredYaml(desired(FULL_EXAMPLE)));
  });

  it('null when no spec was recorded', () => {
    expect(desiredYaml(null)).toBeNull();
    expect(desiredYaml(undefined)).toBeNull();
  });
});
