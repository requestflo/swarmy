/**
 * The edge's country database — the org setting behind country allow/deny
 * rules. Lives in the org's ingress settings (swarm-kv `ingress/<orgId>`,
 * `settings.geoip`): small, changed at human speed, converged by the edge
 * render. The pure choice is `resolveEdgeGeoip` in @swarmy/ingress; the
 * render threads its path into `extraConfig.geoipMmdbPath`.
 */
import {
  EDGE_GEOIP_ATTRIBUTION,
  EDGE_GEOIP_BUNDLED_PATH,
  readEdgeGeoipSetting,
  resolveEdgeGeoip,
  type EdgeGeoipMode,
  type EdgeGeoipResolution,
  type EdgeGeoipSetting,
} from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { defaultEdgeImage } from './ingress-controller';
import { ingressConfigRepo, ingressSettingsOf } from './ingress-config.repo';

export interface EdgeGeoipView {
  /** The chosen mode (`bundled` when never set). */
  mode: EdgeGeoipMode;
  /** The operator mmdb path (mode `file`), else null. */
  path: string | null;
  /** What the edge renders with right now; null = country rules are not enforced. */
  effectivePath: string | null;
  source: EdgeGeoipResolution['source'];
  bundledPath: string;
  /** CC BY 4.0 attribution — show it whenever the bundled database is in use. */
  attribution: string;
}

/** The pieces of the persisted ingress settings the choice depends on. */
export function edgeGeoipInputs(settings: Record<string, unknown>): Parameters<typeof resolveEdgeGeoip>[0] {
  const extra = (settings.globalOptions as { extraConfig?: Record<string, unknown> } | undefined)?.extraConfig;
  return {
    setting: readEdgeGeoipSetting(settings.geoip),
    image: typeof settings.controllerImage === 'string' && settings.controllerImage ? settings.controllerImage : defaultEdgeImage(),
    legacyPath: extra?.geoipMmdbPath,
  };
}

function view(settings: Record<string, unknown>): EdgeGeoipView {
  const inputs = edgeGeoipInputs(settings);
  const r = resolveEdgeGeoip(inputs);
  const legacy = !inputs.setting && r.source === 'file';
  return {
    mode: inputs.setting?.mode ?? (legacy ? 'file' : 'bundled'),
    path: inputs.setting?.path ?? (legacy ? r.path : null),
    effectivePath: r.path || null,
    source: r.source,
    bundledPath: EDGE_GEOIP_BUNDLED_PATH,
    attribution: EDGE_GEOIP_ATTRIBUTION,
  };
}

export async function getEdgeGeoip(ctx: OrgContext): Promise<EdgeGeoipView> {
  return view(ingressSettingsOf(await ingressConfigRepo.get(ctx, ctx.activeOrgId)));
}

/** Choose the edge's country database (audited), then re-render the edge. */
export async function setEdgeGeoip(
  ctx: OrgContext,
  input: EdgeGeoipSetting,
  reapply: (ctx: OrgContext) => Promise<unknown>,
): Promise<EdgeGeoipView> {
  const setting: EdgeGeoipSetting = input.mode === 'file' ? input : { mode: input.mode };
  const row = await ingressConfigRepo.update(ctx, ctx.activeOrgId, (cur) => ({
    settings: { ...ingressSettingsOf(cur), geoip: setting },
  }));
  await writeAudit(ctx, {
    action: 'ingress.setEdgeGeoip',
    targetType: 'ingressConfig',
    targetId: ctx.activeOrgId,
    metadata: { ...setting },
  });
  await reapply(ctx).catch(() => undefined);
  return view(ingressSettingsOf(row));
}
