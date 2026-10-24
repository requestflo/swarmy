/**
 * Per-app conversion funnels — Docker truth, beside the RUM settings.
 *
 * The list is the `swarmy.rum.funnels` label (JSON) on every live service of
 * the app's stack, read back from the live inventory like `swarmy.rum`. It
 * never reaches the edge, so saving re-renders nothing — the next
 * `rum.funnel` read just uses it.
 */
import { FunnelsSchema, RUM_FUNNELS_LABEL, readRumFunnels, serializeRumFunnels, type Funnel } from '@swarmy/rum';
import type { OrgContext } from '../../context';
import { resolveManagerNode } from '../dispatch.service';
import { writeAudit } from '../audit.service';
import { mapDispatchError, notFound } from '../../errors';
import { stackServices } from './rum-settings.service';

export interface RumFunnelsView {
  stack: string;
  funnels: Funnel[];
}

/** The app's funnels, read off its live services (first labelled one wins). */
export function appRumFunnels(ctx: Pick<OrgContext, 'hub' | 'activeOrgId'>, stack: string): Funnel[] {
  return readRumFunnels(stackServices(ctx, stack).find((s) => s.labels[RUM_FUNNELS_LABEL])?.labels);
}

/**
 * `written`: the label value this request just wrote. The live inventory lags
 * a label write by a snapshot tick (QA-031), so the answer overlays it.
 */
export function getRumFunnels(ctx: OrgContext, stack: string, written?: string): RumFunnelsView {
  const services = stackServices(ctx, stack);
  if (services.length === 0) throw notFound('stack', stack);
  const funnels = written !== undefined ? readRumFunnels({ [RUM_FUNNELS_LABEL]: written }) : appRumFunnels(ctx, stack);
  return { stack, funnels };
}

/** Replace the app's funnel list (an empty list clears the label). Audited. */
export async function setRumFunnels(ctx: OrgContext, input: { stack: string; funnels: Funnel[] }): Promise<RumFunnelsView> {
  const funnels = FunnelsSchema.parse(input.funnels);
  const services = stackServices(ctx, input.stack);
  if (services.length === 0) throw notFound('stack', input.stack);
  const value = funnels.length ? serializeRumFunnels(funnels) : '';
  const node = await resolveManagerNode(ctx);
  try {
    for (const svc of services) {
      const current = svc.labels[RUM_FUNNELS_LABEL] ?? '';
      if (current === value) continue;
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        add: value ? { [RUM_FUNNELS_LABEL]: value } : {},
        removeKeys: value ? [] : [RUM_FUNNELS_LABEL],
      });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'rum.funnels.update',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { funnels: funnels.map((f) => ({ id: f.id, name: f.name, steps: f.steps.length, windowMinutes: f.windowMinutes })) },
  });
  return getRumFunnels(ctx, input.stack, value);
}
