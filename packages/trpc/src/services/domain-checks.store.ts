/**
 * Persistence for custom-domain checks — `IngressConfig.settings.domainChecks`.
 *
 * WHY here and not a label: a check record is the controller's OBSERVATION of
 * the outside world (what public DNS answers, what certificate the edge
 * serves) plus the onboarding gate — not a declaration of how a service
 * behaves. Writing it onto the user's service label would churn the service
 * spec every check. It is not a mirror of routes either: routes stay on
 * `swarmy.ingress.routes`, and a record whose host is no longer routed is
 * pruned. Losing it degrades gracefully (hosts re-verify within a tick).
 *
 * Writes are ATOMIC jsonb merges scoped to `domainChecks` — never a whole
 * settings read-modify-write — so a check never clobbers someone's topology /
 * tunnel change. (The older whole-settings `patchSettings` writers can still
 * write back a stale `domainChecks` copy; that only loses one check result,
 * which the next tick redoes.)
 */
import { domainChecksOf, type DomainCheckRecord, type DomainChecks } from '@swarmy/ingress';
import type { OrgContext } from '../context';

/** The raw settings JSON of the org's ingress config ({} when no row). */
export async function readIngressSettingsRaw(ctx: OrgContext): Promise<Record<string, unknown>> {
  const row = await ctx.db.ingressConfig.findUnique({
    where: { orgId: ctx.activeOrgId },
    select: { settings: true },
  });
  const s = row?.settings;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

export { domainChecksOf };

export async function readDomainChecks(ctx: OrgContext): Promise<DomainChecks | undefined> {
  return domainChecksOf(await readIngressSettingsRaw(ctx));
}

export interface DomainChecksPatch {
  upserts?: DomainCheckRecord[];
  remove?: string[];
}

/**
 * Merge per-host upserts/removals into `settings.domainChecks` in ONE atomic
 * UPDATE. Requires the config row to exist (every org with routes has one —
 * `ensureConfig` runs on the first ingress read); a missing row is a no-op.
 */
export async function patchDomainChecks(ctx: OrgContext, patch: DomainChecksPatch): Promise<void> {
  const upserts: Record<string, DomainCheckRecord> = {};
  for (const r of patch.upserts ?? []) upserts[r.host] = r;
  const remove = patch.remove ?? [];
  if (Object.keys(upserts).length === 0 && remove.length === 0) return;
  await ctx.db.$executeRaw`
    UPDATE ingress_config
    SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
          'domainChecks',
          COALESCE(settings->'domainChecks', '{}'::jsonb)
            || jsonb_build_object(
                 'hosts',
                 (COALESCE(settings->'domainChecks'->'hosts', '{}'::jsonb) || ${JSON.stringify(upserts)}::jsonb)
                   - ${remove}::text[]
               )
        ),
        "updatedAt" = now()
    WHERE "orgId" = ${ctx.activeOrgId}`;
}
