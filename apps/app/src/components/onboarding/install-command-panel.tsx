import * as React from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { ResolvedControllerUrl } from '@swarmy/core';
import type { NodeRoleChoice } from './node-role-picker';

export interface MeshSetupKey {
  setupKey: string;
  managementUrl?: string;
  driver?: string;
}

/** Where the one-liner points (server-resolved; see `resolveControllerPublicUrl`). */
export type InstallTarget = Pick<ResolvedControllerUrl, 'url' | 'loopback' | 'warning'>;

/** Fallback when the API didn't send a target (demo mode / older controller). */
function browserTarget(): InstallTarget {
  const url = typeof window !== 'undefined' ? window.location.origin : '';
  return { url, loopback: false, warning: null };
}

/**
 * Build the paste-on-the-box install command (also used by the node repair
 * card + Settings → Join tokens). ONE controller base drives every hop: the
 * outer curl fetches the loader from it, and `--controller <base>` makes the
 * loader derive the installer, agent-binary, and dial-back URLs from the same
 * base — so it works whatever CONTROLLER_PUBLIC_URL the controller bakes.
 */
export function installOneLiner(
  token: string,
  labels: string,
  role: NodeRoleChoice,
  mesh: MeshSetupKey | null,
  target: InstallTarget | null | undefined = null,
): string {
  const base = (target?.url || browserTarget().url).replace(/\/+$/, '');
  const labelEnv = labels.trim() ? `SWARMY_NODE_LABELS=${labels.trim()} ` : '';
  // `auto` lets the controller decide (first node → manager, rest → worker).
  const roleEnv = role === 'auto' ? '' : `SWARMY_ROLE_HINT=${role} `;
  // Mesh-first join (epic: zero-trust-networking): when the org has mesh
  // enabled, the token carries a single-use NetBird setup key so the agent
  // joins the mesh and confirms connectivity before it registers.
  const meshEnv = mesh
    ? `SWARMY_MESH_SETUP_KEY=${mesh.setupKey} ${mesh.managementUrl ? `SWARMY_MESH_MANAGEMENT_URL=${mesh.managementUrl} ` : ''}${mesh.driver ? `SWARMY_MESH_DRIVER=${mesh.driver} ` : ''}`
    : '';
  // Secrets stay in env (not argv, which `ps` shows); the base rides as an arg.
  return `curl -fsSL ${base}/install/loader.sh | SWARMY_JOIN_TOKEN=${token} ${roleEnv}${labelEnv}${meshEnv}sh -s -- --controller ${base}`;
}

/**
 * Installs are HTTPS-only: the loader and installer refuse a plain-http
 * controller (loopback aside). True when the one-liner would be refused, so
 * the page asks for a dashboard domain instead of showing a dead command.
 */
export function needsHttps(target: InstallTarget | null | undefined): boolean {
  const url = target?.url || browserTarget().url;
  if (!url.startsWith('http://')) return false;
  if (target?.loopback) return false;
  try {
    const host = new URL(url).hostname;
    return !(host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.'));
  } catch {
    return false;
  }
}

/** Shown when the resolved controller address is loopback — remote nodes can't reach it. */
export function ControllerUrlWarning({
  target,
  className,
}: {
  target: InstallTarget | null | undefined;
  className?: string;
}): React.JSX.Element | null {
  if (!target?.loopback) return null;
  return (
    <p className={cn('text-tone-warn flex items-start gap-2 text-xs leading-snug', className)} role="alert">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {target.warning ??
          `This controller only knows itself as ${target.url}. Set CONTROLLER_PUBLIC_URL to an address your nodes can reach.`}
      </span>
    </p>
  );
}
