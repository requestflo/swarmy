import type {
  GuardrailDecisionView,
  GuardrailRuleView,
  GuardrailsConfigView,
  SetGuardrailRuleInput,
  SetGuardrailSafetyModeInput,
  SetStackEnvInput,
  StackEnvView,
} from '@swarmy/core';
import { GUARDRAIL_RULE_IDS } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Guardrails demo resolvers — the Governance surface (`/governance`): the
 * production safety switch, rule toggles, stack environment badges and the
 * blocked/overridden feed. Shapes mirror `guardrails.service.ts` views exactly
 * (imported from @swarmy/core, never redeclared). Seeded per the manifest:
 * safety mode ON, one blocked decision (a `:latest` deploy to the production
 * storefront stack), plus one override for feed variety.
 */

interface GuardrailsState {
  config: GuardrailsConfigView;
  stackEnvs: StackEnvView[];
  decisions: GuardrailDecisionView[];
}

function getState(store: DemoStore): GuardrailsState {
  return store.extra.guardrails as GuardrailsState;
}

const RULE_SEED: Record<
  (typeof GUARDRAIL_RULE_IDS)[number],
  Omit<GuardrailRuleView, 'id'>
> = {
  noLatestTagInProd: { enabled: true, severity: 'block', params: {}, prodOnly: true },
  minDbReplicasProd: { enabled: true, severity: 'block', params: { n: 2 }, prodOnly: true },
  requireBackupPolicy: { enabled: true, severity: 'warn', params: {}, prodOnly: false },
  requireHealthcheck: { enabled: false, severity: 'warn', params: {}, prodOnly: false },
  requireResourceLimits: { enabled: false, severity: 'warn', params: {}, prodOnly: false },
  requireSignedImagesProd: { enabled: false, severity: 'block', params: {}, prodOnly: true },
  noPrivilegedContainers: { enabled: true, severity: 'block', params: {}, prodOnly: false },
  noHostPortsProd: { enabled: true, severity: 'warn', params: {}, prodOnly: true },
};

export const guardrails: DomainResolvers = {
  seed: (store) => {
    const now = Date.now();
    const iso = (agoMs: number): string => new Date(now - agoMs).toISOString();

    store.extra.guardrails = {
      config: {
        productionSafetyMode: true,
        rules: GUARDRAIL_RULE_IDS.map((id) => ({ id, ...RULE_SEED[id] })),
      },
      stackEnvs: [
        { stack: 'data', production: true, serviceCount: 4 },
        { stack: 'platform', production: false, serviceCount: 3 },
        { stack: 'storefront', production: true, serviceCount: 4 },
      ],
      decisions: [
        {
          id: 'dec-1',
          at: iso(35 * 60_000),
          kind: 'blocked',
          action: 'guardrails.deploy.blocked',
          actor: store.user.name,
          stack: 'storefront',
          violations: [
            {
              rule: 'guardrails/no-latest-tag-in-prod',
              severity: 'block',
              message:
                'web would deploy ghcr.io/northwind/web:latest to production — pin a version tag so rollbacks mean something.',
              resource: 'web',
            },
            {
              rule: 'guardrails/require-signed-images-prod',
              severity: 'block',
              message:
                'Production requires signed images, but registry signing enforcement is off — enable "Require signed images" in Registry policy (or override).',
              resource: 'storefront',
            },
          ],
        },
        {
          id: 'dec-2',
          at: iso(26 * 3_600_000),
          kind: 'overridden',
          action: 'stack.deploy.override',
          actor: store.user.name,
          stack: 'data',
          violations: [
            {
              rule: 'guardrails/min-db-replicas-prod',
              severity: 'block',
              message:
                'Database cluster main runs 1 read replica in production — guardrails require at least 2.',
              resource: 'main',
            },
          ],
        },
      ],
    } satisfies GuardrailsState;
  },

  handlers: {
    'guardrails.config': (_i, s): GuardrailsConfigView => {
      const st = getState(s);
      return { ...st.config, rules: st.config.rules.map((r) => ({ ...r, params: { ...r.params } })) };
    },

    'guardrails.setSafetyMode': (i, s): GuardrailsConfigView => {
      const st = getState(s);
      st.config.productionSafetyMode = (i as SetGuardrailSafetyModeInput).enabled;
      return { ...st.config, rules: st.config.rules.map((r) => ({ ...r })) };
    },

    'guardrails.setRule': (i, s): GuardrailsConfigView => {
      const st = getState(s);
      const patch = i as SetGuardrailRuleInput;
      st.config.rules = st.config.rules.map((r) =>
        r.id === patch.id
          ? {
              ...r,
              enabled: patch.enabled ?? r.enabled,
              severity: patch.severity ?? r.severity,
              params: patch.params ? { ...r.params, ...patch.params } : r.params,
            }
          : r,
      );
      return { ...st.config, rules: st.config.rules.map((r) => ({ ...r })) };
    },

    'guardrails.stackEnvs': (_i, s): StackEnvView[] => getState(s).stackEnvs.map((e) => ({ ...e })),

    'guardrails.setStackEnv': (i, s): StackEnvView => {
      const st = getState(s);
      const input = i as SetStackEnvInput;
      const row = st.stackEnvs.find((e) => e.stack === input.stack);
      if (row) {
        row.production = input.production;
        return { ...row };
      }
      const created: StackEnvView = { stack: input.stack, production: input.production, serviceCount: 0 };
      st.stackEnvs.push(created);
      return { ...created };
    },

    'guardrails.recentDecisions': (i, s): GuardrailDecisionView[] => {
      const limit = (i as { limit?: number } | undefined)?.limit ?? 50;
      return getState(s)
        .decisions.slice(0, limit)
        .map((d) => ({ ...d, violations: d.violations.map((v) => ({ ...v })) }));
    },
  },
};
