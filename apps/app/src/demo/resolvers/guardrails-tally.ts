import {
  admissionRecord,
  tallyAdmission,
  type AdmissionMode,
  type AdmissionTallyView,
  type GuardrailDecisionView,
  type WouldBlockHit,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo resolver for `guardrails.tally`: thirty days of admission receipts,
 * built with the same `admissionRecord` the controller writes and counted with
 * the same `tallyAdmission`, so the Guardrails page ("On Block it would have
 * stopped N") and the CI page's supply-chain gate read real-shaped numbers.
 * It agrees with the guardrails feed: the storefront `:latest` refusal and the
 * data override are seeded there, and the image refusals and override below
 * are added to it, so the CI page's "went past it by override" lines line up.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type V = [rule: string, severity: 'block' | 'warn', resource: string];
type W = [rule: string, level: 'warn' | 'off', resource: string];
interface Receipt {
  ago: number;
  stack: string;
  violations?: V[];
  wouldBlock?: W[];
  admitted: boolean;
  mode?: AdmissionMode;
  /** Already in the guardrails feed seed. */
  inFeed?: true;
}

const MESSAGES: Record<string, string> = {
  'images/critical-cves': 'localhost:5000/northwind-web:1.8.2 has 2 critical CVEs — fix or override to deploy.',
  'images/unsigned': 'localhost:5000/northwind-api:2.4.0 is not signed with the org cosign key — rebuild with signing enabled or override.',
};

const LATEST: V = ['guardrails/no-latest-tag-in-prod', 'block', 'web'];
const SIGNED_PROD: V = ['guardrails/require-signed-images-prod', 'block', 'storefront'];
const CVES: V = ['images/critical-cves', 'block', 'web'];
const UNSIGNED: V = ['images/unsigned', 'block', 'api'];
const UNSCANNED: V = ['images/unscanned', 'warn', 'worker'];
const HEALTH: W = ['guardrails/require-healthcheck', 'off', 'worker'];
const LIMITS: W = ['guardrails/require-resource-limits', 'off', 'worker'];
const BACKUP: W = ['guardrails/require-backup-policy', 'warn', 'platform'];

const RECEIPTS: Receipt[] = [
  { ago: 0.6 * HOUR, stack: 'storefront', violations: [LATEST, SIGNED_PROD], admitted: false, inFeed: true },
  { ago: 5 * HOUR, stack: 'platform', wouldBlock: [HEALTH, LIMITS], admitted: true },
  { ago: 26 * HOUR, stack: 'data', violations: [['guardrails/min-db-replicas-prod', 'block', 'main']], admitted: true, inFeed: true },
  { ago: 2 * DAY, stack: 'storefront', violations: [CVES], admitted: false },
  { ago: 2.1 * DAY, stack: 'storefront', violations: [CVES], admitted: false },
  { ago: 3 * DAY, stack: 'platform', violations: [UNSCANNED], wouldBlock: [HEALTH], admitted: true, mode: 'automation' },
  { ago: 4 * DAY, stack: 'platform', violations: [UNSIGNED], admitted: false, mode: 'automation' },
  { ago: 6 * DAY, stack: 'platform', violations: [['guardrails/require-backup-policy', 'warn', 'platform']], wouldBlock: [BACKUP, HEALTH], admitted: true, mode: 'automation' },
  { ago: 9 * DAY, stack: 'storefront', violations: [CVES], admitted: true },
  { ago: 12 * DAY, stack: 'platform', wouldBlock: [HEALTH, LIMITS], admitted: true },
  { ago: 17 * DAY, stack: 'platform', violations: [UNSCANNED], admitted: true, mode: 'automation' },
  { ago: 23 * DAY, stack: 'platform', wouldBlock: [LIMITS], admitted: true },
];

interface DemoRow {
  at: number;
  action: string;
  targetId: string;
  metadata: unknown;
}

function seedRows(now: number, feed: GuardrailDecisionView[] | undefined, actor: string): DemoRow[] {
  return RECEIPTS.flatMap((r, i) => {
    const violations = (r.violations ?? []).map(([rule, severity, resource]) => ({ rule, severity, message: MESSAGES[rule] ?? rule, resource }));
    const row = admissionRecord({
      kind: 'stack.deploy',
      stackName: r.stack,
      mode: r.mode ?? 'interactive',
      violations,
      wouldBlock: (r.wouldBlock ?? []).map(([rule, level, resource]): WouldBlockHit => ({ rule, level, resources: [resource] })),
      admitted: r.admitted,
    });
    if (!row) return [];
    const kind = row.metadata.outcome === 'blocked' ? 'blocked' : row.action.endsWith('.override') ? 'overridden' : null;
    if (feed && kind && !r.inFeed) {
      const actorName = r.mode === 'automation' ? null : actor;
      feed.push({ id: `dec-r${i}`, at: new Date(now - r.ago).toISOString(), kind, action: row.action, actor: actorName, stack: r.stack, violations });
    }
    return [{ at: now - r.ago, action: row.action, targetId: r.stack, metadata: row.metadata }];
  });
}

const rowsOf = (s: DemoStore): DemoRow[] => s.extra.guardrailReceipts as DemoRow[];

export const guardrailsTally: DomainResolvers = {
  seed: (store) => {
    const feed = (store.extra.guardrails as { decisions?: GuardrailDecisionView[] } | undefined)?.decisions;
    store.extra.guardrailReceipts = seedRows(Date.now(), feed, store.user.name);
    feed?.sort((a, b) => b.at.localeCompare(a.at));
  },
  handlers: {
    'guardrails.tally': (i, s): AdmissionTallyView => {
      const days = (i as { days?: number } | undefined)?.days ?? 30;
      const since = Date.now() - days * DAY;
      const rows = rowsOf(s).filter((r) => r.at >= since);
      return { days, since: new Date(since).toISOString(), capped: false, ...tallyAdmission(rows) };
    },
  },
};
