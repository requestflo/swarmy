import { describe, expect, it } from 'bun:test';
import { GUARDRAIL_RULE_IDS } from './views';
import {
  ADMISSION_ACTIONS,
  admissionChecks,
  admissionOutcome,
  admissionRecord,
  guardrailRuleKey,
  type AdmissionViolationLike,
  type WouldBlockHit,
} from './admission-record';

const latest: AdmissionViolationLike = { rule: 'guardrails/no-latest-tag-in-prod', severity: 'block', message: 'pin it', resource: 'web' };
const latestApi: AdmissionViolationLike = { ...latest, resource: 'api' };
const port: AdmissionViolationLike = { rule: 'exposure/new-published-port', severity: 'warn', message: 'new port', resource: 'web' };
const unsigned: AdmissionViolationLike = { rule: 'images/unsigned', severity: 'block', message: 'unsigned', resource: 'web' };
const health: WouldBlockHit = { rule: 'guardrails/require-healthcheck', level: 'off', resources: ['web'] };

const record = (over: Partial<Parameters<typeof admissionRecord>[0]> = {}) =>
  admissionRecord({ kind: 'stack.deploy', stackName: 'shop', mode: 'interactive', violations: [], wouldBlock: [], admitted: true, ...over });

describe('guardrailRuleKey', () => {
  it('is the kebab key every guardrail violation carries', () => {
    expect(GUARDRAIL_RULE_IDS.map(guardrailRuleKey)).toEqual([
      'guardrails/no-latest-tag-in-prod',
      'guardrails/min-db-replicas-prod',
      'guardrails/require-backup-policy',
      'guardrails/require-healthcheck',
      'guardrails/require-resource-limits',
      'guardrails/require-signed-images-prod',
      'guardrails/no-privileged-containers',
      'guardrails/no-host-ports-prod',
    ]);
  });
});

describe('admissionOutcome and admissionChecks', () => {
  it('a block decides the run; warnings alone are warned; nothing is allowed', () => {
    expect(admissionOutcome([], true)).toBe('allowed');
    expect(admissionOutcome([port], false)).toBe('warned');
    expect(admissionOutcome([port, latest], false)).toBe('blocked');
    expect(admissionOutcome([port, latest], true)).toBe('overridden');
  });

  it('one entry per rule, resources merged; a warn stays warned even when the run is overridden', () => {
    expect(admissionChecks([latest, latestApi, port, unsigned], true)).toEqual([
      { rule: 'guardrails/no-latest-tag-in-prod', outcome: 'overridden', resources: ['web', 'api'] },
      { rule: 'exposure/new-published-port', outcome: 'warned', resources: ['web'] },
      { rule: 'images/unsigned', outcome: 'overridden', resources: ['web'] },
    ]);
    expect(admissionChecks([unsigned], false)).toEqual([{ rule: 'images/unsigned', outcome: 'blocked', resources: ['web'] }]);
  });
});

describe('admissionRecord: one row per run with something to say', () => {
  it('a clean pass with no would-block hits writes nothing', () => {
    expect(record()).toBeNull();
    expect(record({ mode: 'automation' })).toBeNull();
  });

  it('a clean pass that an Off rule would have stopped is an allowed row', () => {
    const row = record({ wouldBlock: [health] });
    expect(row?.action).toBe(ADMISSION_ACTIONS.allowed);
    expect(row?.metadata).toEqual({
      kind: 'stack.deploy', stackName: 'shop', mode: 'interactive', outcome: 'allowed', admitted: true,
      violations: [], checks: [], wouldBlock: [health],
    });
  });

  it('a refused image check is a blocked row naming the check', () => {
    const row = record({ violations: [unsigned], admitted: false });
    expect(row?.action).toBe('guardrails.deploy.blocked');
    expect(row?.metadata.checks).toEqual([{ rule: 'images/unsigned', outcome: 'blocked', resources: ['web'] }]);
  });

  it('warnings held for a confirmation, or passed by automation, are warned rows', () => {
    expect(record({ violations: [port], admitted: false })?.action).toBe('guardrails.deploy.warned');
    const auto = record({ violations: [port], admitted: true, mode: 'automation' });
    expect(auto?.action).toBe('guardrails.deploy.warned');
    expect(auto?.metadata).toMatchObject({ outcome: 'warned', admitted: true, mode: 'automation' });
  });

  it('an interactive run that went past a violation is the override action, reason and all', () => {
    const svc = record({ kind: 'service.deploy', violations: [latest], reason: 'hotfix' });
    expect(svc?.action).toBe('service.deploy.override');
    expect(svc?.metadata).toMatchObject({ outcome: 'overridden', admitted: true, reason: 'hotfix' });
    expect(record({ violations: [port] })?.action).toBe('stack.deploy.override');
    expect(record({ violations: [port] })?.metadata.outcome).toBe('warned');
  });
});
