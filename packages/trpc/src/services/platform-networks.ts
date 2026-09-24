// Controller-side helpers for swarmy's network model (rules: @swarmy/core
// network-policy). Two jobs: make sure the private control-plane overlay
// exists before a bridge service (edge, collector, ClickHouse) attaches to it,
// and size new overlays for the WireGuard mesh when the org runs one.
import { OVERLAY_ENCRYPTED_OPTION, overlayDriverOptions, SWARMY_CONTROL_NETWORK } from '@swarmy/core';
import type { OrgContext } from '../context';
import type { CommandName } from '../hub/types';
import { mapDispatchError } from '../errors';
import { meshConfigRepo } from './mesh-config.repo';

const NETWORK_ENSURE = 'network.ensure' as CommandName;

/**
 * Ensure the private control-plane overlay exists (the installer creates it;
 * this covers dev and pre-split installs). Idempotent — an existing network
 * is never touched.
 */
export async function ensureControlNetwork(ctx: OrgContext, nodeId: string): Promise<void> {
  try {
    await ctx.hub.dispatch(nodeId, NETWORK_ENSURE, {
      name: SWARMY_CONTROL_NETWORK,
      driver: 'overlay',
      attachable: true,
      labels: { 'swarmy.managed': 'true', 'swarmy.role': 'control' },
      options: { [OVERLAY_ENCRYPTED_OPTION]: '' },
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/**
 * Driver options for a NEW overlay this org creates: an MTU that fits the
 * WireGuard tunnel when the org's mesh is on (VXLAN over wt0 at 1500 fragments
 * or black-holes large packets across nodes), plus any caller options
 * (compose `driver_opts`, which win). `undefined` = Docker defaults. Fails
 * open to "no options" if the mesh row can't be read — the agent still
 * inherits the platform overlay's MTU.
 */
export async function overlayOptionsFor(
  ctx: OrgContext,
  opts: { encrypted?: boolean; extra?: Record<string, string> } = {},
): Promise<Record<string, string> | undefined> {
  let mesh: { driver: string; enabled: boolean } | null = null;
  try {
    mesh = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  } catch {
    mesh = null;
  }
  return overlayDriverOptions({
    meshDriver: mesh?.driver ?? null,
    meshEnabled: mesh?.enabled === true,
    encrypted: opts.encrypted,
    extra: opts.extra,
  });
}
