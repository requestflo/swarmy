import { buildInventory, EXPOSE_LABEL, parseExposeMode } from '@swarmy/core';
import type { ManagedDataKind } from '@swarmy/core';
import type { OrgContext } from '../context';
import type { AdmissionIntent, Violation } from './admission.service';
import {
  managedKindOf,
  parseExposureRules,
  type ClassifiableService,
  type ExposureRulesWithIntent,
} from './exposure.service';
import { readRoutes } from './ingress-routes';

/**
 * Exposure admission evaluator (slice E3 + WS3) — enforces the org's exposure
 * rules against what a deploy is ABOUT to do (the intent's service specs):
 *
 * - `noPublicPortsOnManagedData` (block): a spec that publishes a port while
 *   carrying managed-data labels — or targeting a LIVE service that carries
 *   them — is refused.
 * - `noPublicUdp` (block): published UDP ports are refused; an explicit deploy
 *   override is the approval path.
 * - `warnOnNewPublishedPorts` (warn): a published port the live service didn't
 *   already publish surfaces as a warning (redeploys of the existing surface
 *   stay quiet).
 * - `enforceDeclaredIntent` (block): a spec whose `swarmy.expose` declaration
 *   contradicts its own surface (private/mesh with a published port or ingress
 *   route, tunnel with a published port) is refused. Unlike the rules above
 *   this does NOT wait for the org-wide `enforce` switch — declaring a mode on
 *   a service is the per-service opt-in to enforcement, so undeclared services
 *   (every existing org) are untouched.
 *
 * The `ExposureConfig.enforce` flag is the "Block violating deploys" switch
 * for the estate rules: when OFF they stay advisory (the Exposure page + the
 * exposure-audit worker still surface them), because the admission pipeline
 * refuses on ANY returned violation unless the caller overrides.
 */

/** The slice of a deploy spec this evaluator inspects. */
export interface SpecExposureFacts {
  name: string;
  labels: Record<string, string>;
  ports: Array<{ target?: number; published?: number; protocol?: string; mode?: string }>;
}

/** What the live estate already looks like, for "managed?" and "new port?" checks. */
export interface LiveExposureFacts {
  /** Managed-data family of the live service this spec will replace, if any. */
  managedKindFor: (specName: string) => ManagedDataKind | null;
  /** `"<published>/<protocol>"` keys the live service already publishes. */
  publishedKeysFor: (specName: string) => ReadonlySet<string>;
}

/** Coerce unknown intent specs into the facts this evaluator needs. */
export function specFacts(specs: unknown[]): SpecExposureFacts[] {
  const out: SpecExposureFacts[] = [];
  for (const raw of specs) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name) continue;
    const labels =
      typeof o.labels === 'object' && o.labels !== null
        ? (o.labels as Record<string, string>)
        : {};
    const ports = Array.isArray(o.ports)
      ? (o.ports as SpecExposureFacts['ports']).filter((p) => typeof p === 'object' && p !== null)
      : [];
    out.push({ name: o.name, labels, ports });
  }
  return out;
}

const portKey = (published: number, protocol: string | undefined): string =>
  `${published}/${protocol === 'udp' ? 'udp' : 'tcp'}`;

/**
 * Intent-vs-spec (WS3): a spec that declares `swarmy.expose` must not carry a
 * surface its own declaration forbids. Pure on the INCOMING specs — no live
 * estate needed, the contradiction is inside the spec itself.
 */
export function decideDeclaredIntentAdmission(specs: SpecExposureFacts[]): Violation[] {
  const violations: Violation[] = [];
  for (const spec of specs) {
    const declared = parseExposeMode(spec.labels[EXPOSE_LABEL]);
    if (!declared || declared === 'public') continue;
    const published = spec.ports.filter(
      (p) => typeof p.published === 'number' && p.published > 0,
    );
    const routes = readRoutes(spec.labels);
    const ports = published.map((p) => p.published).join(', ');

    if (published.length > 0) {
      violations.push({
        rule: `exposure/intent-${declared}-published-port`,
        severity: 'block',
        message: `${spec.name} declares swarmy.expose=${declared} but publishes port${published.length === 1 ? '' : 's'} ${ports} — remove the publish or change the declared mode.`,
        resource: spec.name,
      });
    }
    if (routes.length > 0 && declared !== 'tunnel') {
      violations.push({
        rule: `exposure/intent-${declared}-ingress-route`,
        severity: 'block',
        message: `${spec.name} declares swarmy.expose=${declared} but carries ingress route${routes.length === 1 ? '' : 's'} for ${routes.map((r) => r.host).join(', ')} — remove the route or change the declared mode.`,
        resource: spec.name,
      });
    }
  }
  return violations;
}

/**
 * Pure admission decision given already-gathered facts (unit-tested).
 * Estate rules return [] when `rules.enforce` is off (advisory-only mode);
 * declared-intent checks fire whenever `enforceDeclaredIntent` is on, because
 * a spec declaring a mode has opted into enforcement itself.
 */
export function decideExposureAdmission(input: {
  rules: ExposureRulesWithIntent;
  specs: SpecExposureFacts[];
  live: LiveExposureFacts;
}): Violation[] {
  const intent = input.rules.enforceDeclaredIntent
    ? decideDeclaredIntentAdmission(input.specs)
    : [];
  if (!input.rules.enforce) return intent;
  const violations: Violation[] = [...intent];
  for (const spec of input.specs) {
    const published = spec.ports.filter(
      (p) => typeof p.published === 'number' && p.published > 0,
    ) as Array<{ target?: number; published: number; protocol?: string; mode?: string }>;
    if (published.length === 0) continue;

    const managedKind = managedKindOf(spec.labels) ?? input.live.managedKindFor(spec.name);
    if (input.rules.noPublicPortsOnManagedData && managedKind) {
      const ports = published.map((p) => p.published).join(', ');
      violations.push({
        rule: 'exposure/no-public-ports-on-managed-data',
        severity: 'block',
        message: `${spec.name} is a managed ${managedKind} service — remove published port${published.length === 1 ? '' : 's'} ${ports} and use private networking.`,
        resource: spec.name,
      });
    }

    if (input.rules.noPublicUdp) {
      for (const p of published) {
        if (p.protocol !== 'udp') continue;
        violations.push({
          rule: 'exposure/no-public-udp',
          severity: 'block',
          message: `${spec.name} publishes UDP port ${p.published} — remove it, or override to approve UDP exposure.`,
          resource: spec.name,
        });
      }
    }

    if (input.rules.warnOnNewPublishedPorts) {
      const existing = input.live.publishedKeysFor(spec.name);
      const fresh = published.filter((p) => !existing.has(portKey(p.published, p.protocol)));
      if (fresh.length > 0) {
        const ports = fresh.map((p) => portKey(p.published, p.protocol)).join(', ');
        violations.push({
          rule: 'exposure/new-published-port',
          severity: 'warn',
          message: `${spec.name} would newly publish ${ports} to the world — expected? Override to proceed.`,
          resource: spec.name,
        });
      }
    }
  }
  return violations;
}

// ── Evaluator (spine contract) ───────────────────────────────────────────────

export async function evaluate(ctx: OrgContext, intent: AdmissionIntent): Promise<Violation[]> {
  if (
    intent.kind !== 'stack.deploy' &&
    intent.kind !== 'service.deploy' &&
    intent.kind !== 'exposure.change'
  ) {
    return [];
  }
  const specs = specFacts(intent.specs ?? []);
  if (specs.length === 0) return [];

  // No config row yet → defaults: estate rules advisory (enforce off), but the
  // declared-intent gate stays live — it only fires for specs that opt in.
  const cfg = await ctx.db.exposureConfig.findUnique({
    where: { orgId: ctx.activeOrgId },
    select: { rulesJson: true, enforce: true },
  });
  const rules = cfg
    ? parseExposureRules(cfg.rulesJson, cfg.enforce)
    : parseExposureRules({}, false);
  if (!rules.enforce && !rules.enforceDeclaredIntent) return [];

  // Live estate lookup: match a spec to its live service by exact name, or by
  // the `<stack>_<name>` convention when the intent deploys into a stack.
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const byName = new Map<string, ClassifiableService>();
  for (const s of buildInventory(services, containers).services) byName.set(s.name, s);
  const liveFor = (specName: string): ClassifiableService | undefined =>
    byName.get(specName) ??
    (intent.stackName ? byName.get(`${intent.stackName}_${specName}`) : undefined);

  return decideExposureAdmission({
    rules,
    specs,
    live: {
      managedKindFor: (name) => {
        const live = liveFor(name);
        return live ? managedKindOf(live.labels) : null;
      },
      publishedKeysFor: (name) => {
        const live = liveFor(name);
        const keys = new Set<string>();
        for (const p of live?.ports ?? []) {
          if (typeof p.published === 'number' && p.published > 0) {
            keys.add(portKey(p.published, p.protocol));
          }
        }
        return keys;
      },
    },
  });
}
