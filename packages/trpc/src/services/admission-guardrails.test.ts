import { describe, expect, it } from 'bun:test';
import type { GuardrailRuleId, GuardrailsConfigView } from '@swarmy/core';
import {
  decideGuardrails,
  effectiveRules,
  isLatestImage,
  specFacts,
  type EffectiveRule,
  type GuardrailEstateFacts,
  type GuardrailSpecFacts,
} from './admission-guardrails';
import { defaultGuardrailRules } from './guardrails.service';

function spec(over: Partial<GuardrailSpecFacts> = {}): GuardrailSpecFacts {
  return {
    name: 'web',
    image: 'ghcr.io/acme/web:1.4.2',
    labels: {},
    hostPorts: [],
    hasHealthcheck: true,
    hasMemoryLimit: true,
    privileged: false,
    ...over,
  };
}

function estate(over: Partial<GuardrailEstateFacts> = {}): GuardrailEstateFacts {
  return { dbClusters: [], hasOrgBackupSchedules: false, signingEnforced: false, ...over };
}

/** A rules map with exactly the given rules active. */
function only(
  ...entries: Array<[GuardrailRuleId, Partial<EffectiveRule>?]>
): Map<GuardrailRuleId, EffectiveRule> {
  const m = new Map<GuardrailRuleId, EffectiveRule>();
  for (const [id, over] of entries) m.set(id, { severity: 'block', params: {}, ...over });
  return m;
}

function decide(input: {
  rules: Map<GuardrailRuleId, EffectiveRule>;
  specs: GuardrailSpecFacts[];
  estate?: GuardrailEstateFacts;
  isProd?: boolean;
  stackName?: string;
}) {
  return decideGuardrails({
    rules: input.rules,
    isProd: input.isProd ?? true,
    stackName: input.stackName ?? 'shop',
    specs: input.specs,
    estate: input.estate ?? estate(),
  });
}

describe('specFacts — coercion of unknown intent specs', () => {
  it('extracts healthcheck / memory limit / privileged / host-port facts', () => {
    const facts = specFacts([
      {
        name: 'a',
        image: 'x:1',
        healthcheck: { test: ['CMD', 'true'] },
        resources: { limits: { memoryBytes: 256 * 1024 * 1024 } },
        ports: [
          { target: 80, published: 8080, mode: 'host' },
          { target: 81, published: 8081, mode: 'ingress' },
        ],
      },
      { name: 'b', image: 'y:2', privileged: true },
      { name: 'c', image: 'z:3', capAdd: ['SYS_ADMIN'] },
      { image: 'no-name' },
      null,
      'junk',
    ]);
    expect(facts.map((f) => f.name)).toEqual(['a', 'b', 'c']);
    expect(facts[0]).toMatchObject({
      hasHealthcheck: true,
      hasMemoryLimit: true,
      hostPorts: [8080],
      privileged: false,
    });
    expect(facts[1]!.privileged).toBe(true);
    expect(facts[1]!.hasHealthcheck).toBe(false);
    expect(facts[1]!.hasMemoryLimit).toBe(false);
    expect(facts[2]!.privileged).toBe(true);
  });

  it('treats disabled healthchecks (disable / NONE) as absent', () => {
    const facts = specFacts([
      { name: 'a', image: 'x', healthcheck: { disable: true } },
      { name: 'b', image: 'x', healthcheck: { test: ['NONE'] } },
      { name: 'c', image: 'x', healthcheck: {} },
    ]);
    expect(facts.map((f) => f.hasHealthcheck)).toEqual([false, false, true]);
  });
});

describe('isLatestImage', () => {
  it('flags explicit and implicit :latest, spares pinned refs', () => {
    expect(isLatestImage('nginx:latest')).toBe(true);
    expect(isLatestImage('nginx')).toBe(true); // no tag → docker pulls :latest
    expect(isLatestImage('registry.local:5000/app')).toBe(true); // port ≠ tag
    expect(isLatestImage('nginx:1.27')).toBe(false);
    expect(isLatestImage('registry.local:5000/app:v3')).toBe(false);
    expect(isLatestImage('app@sha256:abc')).toBe(false); // digest-pinned
    expect(isLatestImage('app:latest@sha256:abc')).toBe(false);
    expect(isLatestImage('')).toBe(false);
  });
});

describe('effectiveRules — env scoping + production safety mode', () => {
  const config = (over: Partial<GuardrailsConfigView> = {}): GuardrailsConfigView => ({
    productionSafetyMode: false,
    rules: defaultGuardrailRules(),
    ...over,
  });

  it('prod-only rules never activate off production', () => {
    const rules = effectiveRules(config(), false);
    expect(rules.has('noLatestTagInProd')).toBe(false);
    expect(rules.has('minDbReplicasProd')).toBe(false);
    expect(rules.has('noHostPortsProd')).toBe(false);
    expect(rules.has('requireSignedImagesProd')).toBe(false);
    // estate-wide default-enabled rule still applies
    expect(rules.has('noPrivilegedContainers')).toBe(true);
  });

  it('disabled rules stay off when safety mode is off (per-rule overrides respected)', () => {
    const rules = effectiveRules(config(), true);
    expect(rules.has('requireHealthcheck')).toBe(false); // default disabled
    expect(rules.get('noHostPortsProd')?.severity).toBe('warn'); // default severity kept
  });

  it('safety mode ON + prod target ⇒ every rule active at block severity', () => {
    const rules = effectiveRules(config({ productionSafetyMode: true }), true);
    expect(rules.size).toBe(defaultGuardrailRules().length);
    for (const [, r] of rules) expect(r.severity).toBe('block');
    // params ride along
    expect(rules.get('minDbReplicasProd')?.params.n).toBe(2);
  });

  it('safety mode ON but non-prod target ⇒ per-rule settings still govern', () => {
    const rules = effectiveRules(config({ productionSafetyMode: true }), false);
    expect(rules.has('noLatestTagInProd')).toBe(false); // prodOnly
    expect(rules.has('requireHealthcheck')).toBe(false); // disabled by default
    expect(rules.has('noPrivilegedContainers')).toBe(true);
  });
});

describe('rule: noLatestTagInProd', () => {
  it('blocks :latest and untagged images, spares pinned ones', () => {
    const v = decide({
      rules: only(['noLatestTagInProd']),
      specs: [
        spec({ name: 'web', image: 'ghcr.io/acme/web:latest' }),
        spec({ name: 'worker', image: 'ghcr.io/acme/worker' }),
        spec({ name: 'api', image: 'ghcr.io/acme/api:2.1.0' }),
      ],
    });
    expect(v.map((x) => x.resource)).toEqual(['web', 'worker']);
    expect(v.every((x) => x.rule === 'guardrails/no-latest-tag-in-prod')).toBe(true);
  });
});

describe('rule: minDbReplicasProd', () => {
  it('flags clusters below n (default 2) and honors the params override', () => {
    const clusters = [
      { cluster: 'main', declaredReplicas: 1, hasBackupSchedule: true },
      { cluster: 'analytics', declaredReplicas: 2, hasBackupSchedule: true },
    ];
    const v = decide({
      rules: only(['minDbReplicasProd']),
      specs: [spec()],
      estate: estate({ dbClusters: clusters }),
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.resource).toBe('main');
    expect(v[0]!.message).toContain('at least 2');

    const v3 = decide({
      rules: only(['minDbReplicasProd', { params: { n: 3 } }]),
      specs: [spec()],
      estate: estate({ dbClusters: clusters }),
    });
    expect(v3.map((x) => x.resource).sort()).toEqual(['analytics', 'main']);
  });
});

describe('rule: requireBackupPolicy', () => {
  const dbNoBackup = [{ cluster: 'main', declaredReplicas: 2, hasBackupSchedule: false }];

  it('fires when a stack has a db and no schedule anywhere', () => {
    const v = decide({
      rules: only(['requireBackupPolicy', { severity: 'warn' }]),
      specs: [spec()],
      estate: estate({ dbClusters: dbNoBackup }),
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'guardrails/require-backup-policy', severity: 'warn' });
  });

  it('satisfied by a db backup schedule label OR org BackupSchedule rows', () => {
    const viaLabel = decide({
      rules: only(['requireBackupPolicy']),
      specs: [spec()],
      estate: estate({
        dbClusters: [{ cluster: 'main', declaredReplicas: 2, hasBackupSchedule: true }],
      }),
    });
    expect(viaLabel).toEqual([]);

    const viaRows = decide({
      rules: only(['requireBackupPolicy']),
      specs: [spec()],
      estate: estate({ dbClusters: dbNoBackup, hasOrgBackupSchedules: true }),
    });
    expect(viaRows).toEqual([]);
  });

  it('stays quiet when the stack has no database', () => {
    const v = decide({ rules: only(['requireBackupPolicy']), specs: [spec()] });
    expect(v).toEqual([]);
  });
});

describe('rule: requireHealthcheck', () => {
  it('flags every spec without a healthcheck', () => {
    const v = decide({
      rules: only(['requireHealthcheck', { severity: 'warn' }]),
      specs: [spec({ name: 'ok' }), spec({ name: 'naked', hasHealthcheck: false })],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      rule: 'guardrails/require-healthcheck',
      severity: 'warn',
      resource: 'naked',
    });
  });
});

describe('rule: requireResourceLimits', () => {
  it('flags every spec without a memory limit', () => {
    const v = decide({
      rules: only(['requireResourceLimits']),
      specs: [spec({ name: 'capped' }), spec({ name: 'unbounded', hasMemoryLimit: false })],
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.resource).toBe('unbounded');
    expect(v[0]!.rule).toBe('guardrails/require-resource-limits');
  });
});

describe('rule: requireSignedImagesProd (delegation to D3)', () => {
  it('emits only when D3 signing enforcement is OFF', () => {
    const off = decide({ rules: only(['requireSignedImagesProd']), specs: [spec()] });
    expect(off).toHaveLength(1);
    expect(off[0]!.rule).toBe('guardrails/require-signed-images-prod');

    const on = decide({
      rules: only(['requireSignedImagesProd']),
      specs: [spec()],
      estate: estate({ signingEnforced: true }),
    });
    expect(on).toEqual([]); // defer to the image-policy evaluator
  });

  it('stays quiet when the intent deploys no images', () => {
    const v = decide({
      rules: only(['requireSignedImagesProd']),
      specs: [spec({ image: '' })],
    });
    expect(v).toEqual([]);
  });
});

describe('rule: noPrivilegedContainers', () => {
  it('blocks privileged specs only', () => {
    const v = decide({
      rules: only(['noPrivilegedContainers']),
      specs: [spec({ name: 'plain' }), spec({ name: 'root', privileged: true })],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      rule: 'guardrails/no-privileged-containers',
      severity: 'block',
      resource: 'root',
    });
  });
});

describe('rule: noHostPortsProd', () => {
  it('flags host-mode published ports and lists them', () => {
    const v = decide({
      rules: only(['noHostPortsProd', { severity: 'warn' }]),
      specs: [spec({ name: 'edge', hostPorts: [80, 443] }), spec({ name: 'quiet' })],
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toContain('80, 443');
    expect(v[0]!.rule).toBe('guardrails/no-host-ports-prod');
  });
});

describe('end to end: safety mode forces block severity in prod', () => {
  it('a :latest deploy to a prod stack under safety mode blocks even if the rule was warn', () => {
    const config: GuardrailsConfigView = {
      productionSafetyMode: true,
      rules: defaultGuardrailRules().map((r) =>
        r.id === 'noLatestTagInProd' ? { ...r, enabled: false, severity: 'warn' as const } : r,
      ),
    };
    const rules = effectiveRules(config, true);
    const v = decideGuardrails({
      rules,
      isProd: true,
      stackName: 'shop',
      specs: [spec({ image: 'web:latest' })],
      estate: estate({ signingEnforced: true }),
    });
    const latest = v.find((x) => x.rule === 'guardrails/no-latest-tag-in-prod');
    expect(latest?.severity).toBe('block');
  });
});
