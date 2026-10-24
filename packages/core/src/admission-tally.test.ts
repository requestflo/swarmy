import { describe, expect, it } from 'bun:test';
import { admissionRecord, type AdmissionRecordInput } from './admission-record';
import { readAdmissionRow, tallyAdmission, type AdmissionRowLike } from './admission-tally';

const block = (rule: string, resource = 'web') => ({ rule, severity: 'block' as const, message: rule, resource });
const warn = (rule: string, resource = 'web') => ({ rule, severity: 'warn' as const, message: rule, resource });

/** A row exactly as the gate writes it. */
function row(over: Partial<AdmissionRecordInput>, targetId = 'shop'): AdmissionRowLike {
  const r = admissionRecord({ kind: 'stack.deploy', stackName: targetId, mode: 'interactive', violations: [], wouldBlock: [], admitted: true, ...over });
  if (!r) throw new Error('clean pass: no row');
  return { action: r.action, targetId, metadata: r.metadata };
}

describe('tallyAdmission: the receipts per rule', () => {
  it('counts blocked, warned and overridden per check, and totals per outcome', () => {
    const t = tallyAdmission([
      row({ violations: [block('images/unsigned')], admitted: false }),
      row({ violations: [block('images/unsigned'), block('images/unsigned', 'api')], admitted: false }, 'blog'),
      row({ violations: [block('images/critical-cves')], reason: 'patched tonight' }),
      row({ violations: [warn('images/unscanned')], admitted: true, mode: 'automation' }),
    ]);
    expect(t.totals).toEqual({ blocked: 2, warned: 1, overridden: 1, allowed: 0 });
    expect(t.rules).toEqual([
      { rule: 'images/critical-cves', blocked: 0, warned: 0, overridden: 1, wouldBlock: 0, stacks: ['shop'] },
      { rule: 'images/unscanned', blocked: 0, warned: 1, overridden: 0, wouldBlock: 0, stacks: ['shop'] },
      { rule: 'images/unsigned', blocked: 2, warned: 0, overridden: 0, wouldBlock: 0, stacks: ['shop', 'blog'] },
    ]);
  });

  it('would-have-blocked counts only deploys that went ahead, once per run', () => {
    const health = { rule: 'guardrails/require-healthcheck', level: 'off' as const, resources: ['web', 'api'] };
    const t = tallyAdmission([
      row({ wouldBlock: [health] }),
      row({ wouldBlock: [health, { ...health }] }, 'blog'),
      // refused anyway by another rule: it shipped nothing, so it isn't "would have stopped"
      row({ violations: [block('guardrails/no-privileged-containers')], wouldBlock: [health], admitted: false }),
    ]);
    const h = t.rules.find((r) => r.rule === 'guardrails/require-healthcheck');
    expect(h).toEqual({ rule: 'guardrails/require-healthcheck', blocked: 0, warned: 0, overridden: 0, wouldBlock: 2, stacks: ['shop', 'blog'] });
    expect(t.totals.allowed).toBe(2);
  });

  it('reads rows written before receipts carried checks', () => {
    const legacy: AdmissionRowLike[] = [
      { action: 'guardrails.deploy.blocked', targetId: 'shop', metadata: { stackName: 'shop', isProd: true, violations: [block('guardrails/no-latest-tag-in-prod')] } },
      { action: 'service.deploy.override', targetId: 'web', metadata: { violations: [block('guardrails/no-latest-tag-in-prod')], reason: 'x' } },
      { action: 'stack.deploy', targetId: 'shop', metadata: { violations: [block('nope')] } },
    ];
    expect(readAdmissionRow(legacy[1]!)).toMatchObject({ outcome: 'overridden', admitted: true, stack: 'web' });
    expect(readAdmissionRow(legacy[2]!)).toBeNull();
    const t = tallyAdmission(legacy);
    expect(t.totals).toEqual({ blocked: 1, warned: 0, overridden: 1, allowed: 0 });
    expect(t.rules).toEqual([{ rule: 'guardrails/no-latest-tag-in-prod', blocked: 1, warned: 0, overridden: 1, wouldBlock: 0, stacks: ['shop', 'web'] }]);
  });

  it('junk metadata never throws and never invents a count', () => {
    const t = tallyAdmission([
      { action: 'guardrails.deploy.allowed', metadata: null },
      { action: 'guardrails.deploy.blocked', metadata: { checks: 'nope', wouldBlock: [{ rule: 3 }], violations: [null, { severity: 'block' }] } },
    ]);
    expect(t.rules).toEqual([]);
    expect(t.totals).toEqual({ blocked: 1, warned: 0, overridden: 0, allowed: 1 });
  });
});
