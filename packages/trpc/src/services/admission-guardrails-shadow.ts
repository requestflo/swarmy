import type { GuardrailRuleId, GuardrailsConfigView, WouldBlockHit } from '@swarmy/core';
import type { OrgContext } from '../context';
import type { AdmissionIntent } from './admission.service';
import {
  decideGuardrails,
  effectiveRules,
  type EffectiveRule,
  type GuardrailEstateFacts,
} from './admission-guardrails';
import { estateFor, guardrailFacts } from './admission-guardrails-facts';
import type { GuardrailSpecFacts } from './admission-guardrails-specs';

/**
 * "On Block it would have stopped N": every guardrail that is Warn or Off for
 * this intent, re-armed at Block and run through the same pure decision core
 * (`decideGuardrails`). It shares the evaluation's facts, so it adds no reads
 * beyond a lookup an Off rule needs, and it never refuses anything: its hits
 * only ride the admission receipt (`wouldBlock`).
 */

export interface ShadowRule {
  /** What the rule is set to here: Warn (active, warns) or Off (inactive). */
  level: 'warn' | 'off';
  /** The rule re-armed at Block, keeping its params. */
  rule: EffectiveRule;
}

/**
 * Rules that apply to this target but don't block here, re-armed at Block.
 * Prod-only rules never apply outside production; safety mode already blocks
 * every rule in production, so there it leaves nothing to imagine.
 */
export function shadowRules(config: GuardrailsConfigView, isProd: boolean): Map<GuardrailRuleId, ShadowRule> {
  const active = effectiveRules(config, isProd);
  const out = new Map<GuardrailRuleId, ShadowRule>();
  for (const r of config.rules) {
    if (r.prodOnly && !isProd) continue;
    const eff = active.get(r.id);
    if (eff?.severity === 'block') continue;
    out.set(r.id, { level: eff ? 'warn' : 'off', rule: { severity: 'block', params: { ...r.params } } });
  }
  return out;
}

/** Pure: which shadow rules would refuse these specs at Block, one hit per rule. */
export function decideWouldBlock(input: {
  shadow: ReadonlyMap<GuardrailRuleId, ShadowRule>;
  isProd: boolean;
  stackName: string | undefined;
  specs: GuardrailSpecFacts[];
  estate: GuardrailEstateFacts;
}): WouldBlockHit[] {
  const hits: WouldBlockHit[] = [];
  for (const [id, s] of input.shadow) {
    const violations = decideGuardrails({ ...input, rules: new Map([[id, s.rule]]) });
    const first = violations[0];
    if (!first) continue;
    const resources = [...new Set(violations.flatMap((v) => (v.resource ? [v.resource] : [])))];
    hits.push({ rule: first.rule, level: s.level, resources });
  }
  return hits;
}

/** Rules whose shadow needs an estate lookup (backup schedules, registry signing). */
const NEEDS_LOOKUP: GuardrailRuleId[] = ['requireBackupPolicy', 'requireSignedImagesProd'];

/** The would-block hits for one intent. A failed lookup drops only the rules that needed it. */
export async function wouldBlock(ctx: OrgContext, intent: AdmissionIntent): Promise<WouldBlockHit[]> {
  const facts = await guardrailFacts(ctx, intent);
  if (!facts) return [];
  const shadow = shadowRules(facts.config, facts.isProd);
  if (shadow.size === 0) return [];
  let estate: GuardrailEstateFacts;
  try {
    estate = await estateFor(facts, new Set(shadow.keys()));
  } catch {
    for (const id of NEEDS_LOOKUP) shadow.delete(id);
    estate = await estateFor(facts, new Set());
  }
  return decideWouldBlock({ shadow, isProd: facts.isProd, stackName: intent.stackName, specs: facts.specs, estate });
}
