import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, KeyRoundIcon, TerminalIcon } from 'lucide-react';
import { CopyButton, StatusBadge, cn } from '@swarmy/ui';
import type { AwaitedNode } from './use-await-node';
import type { NodeRoleChoice } from './node-role-picker';

export interface MeshSetupKey {
  setupKey: string;
  managementUrl?: string;
  driver?: string;
}

/** Build the paste-on-the-box install command (also used by the node repair card). */
export function installOneLiner(token: string, labels: string, role: NodeRoleChoice, mesh: MeshSetupKey | null): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const labelEnv = labels.trim() ? `SWARMY_NODE_LABELS=${labels.trim()} ` : '';
  // `auto` lets the controller decide (first node → manager, rest → worker).
  const roleEnv = role === 'auto' ? '' : `SWARMY_ROLE_HINT=${role} `;
  // Mesh-first join (epic: zero-trust-networking): when the org has mesh
  // enabled, the token carries a single-use NetBird setup key so the agent
  // joins the mesh and confirms connectivity before it registers.
  const meshEnv = mesh
    ? `SWARMY_MESH_SETUP_KEY=${mesh.setupKey} ${mesh.managementUrl ? `SWARMY_MESH_MANAGEMENT_URL=${mesh.managementUrl} ` : ''}${mesh.driver ? `SWARMY_MESH_DRIVER=${mesh.driver} ` : ''}`
    : '';
  return `curl -fsSL ${origin}/install.sh | SWARMY_JOIN_TOKEN=${token} ${roleEnv}${labelEnv}${meshEnv}sh`;
}

interface InstallCommandPanelProps {
  token: string;
  labels: string;
  role: NodeRoleChoice;
  mesh: MeshSetupKey | null;
  arrived: AwaitedNode | null;
}

/**
 * Ink-block statement surface: the minted one-liner to paste on a fresh box,
 * with a live "watch it connect" footer that flips to a success link on arrival.
 */
export function InstallCommandPanel({
  token,
  labels,
  role,
  mesh,
  arrived,
}: InstallCommandPanelProps): React.JSX.Element {
  const oneLiner = installOneLiner(token, labels, role, mesh);
  return (
    <div className="ink-block grid gap-5 rounded-2xl border-0 p-6 sm:p-8">
      <div className="flex items-start gap-3">
        <span className="bg-primary/15 text-primary inline-flex size-9 shrink-0 items-center justify-center rounded-xl">
          <KeyRoundIcon className="size-5" />
        </span>
        <div>
          <p className="text-base font-bold">Paste this on any fresh Linux box.</p>
          <p className="text-ink-foreground/60 text-sm">
            Copy it now — the token won&apos;t be shown again. It installs Docker if needed, starts the
            agent, and the node phones home.
          </p>
          {mesh ? (
            <p className="text-primary/80 mt-1 text-xs font-medium">
              Mesh enabled — this node joins {mesh.driver ?? 'the mesh'} and confirms connectivity before
              joining the swarm.
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-xl px-3.5 py-3 text-xs">
          <TerminalIcon className="text-primary mr-2 inline size-3.5" />
          {oneLiner}
        </code>
        <CopyButton value={oneLiner} label="Copy" />
      </div>

      <ArrivalFooter arrived={arrived} />
    </div>
  );
}

function ArrivalFooter({ arrived }: { arrived: AwaitedNode | null }): React.JSX.Element {
  if (arrived) {
    return (
      <Link
        to="/nodes/$nodeId"
        params={{ nodeId: arrived.id }}
        className="bg-primary/12 hover:bg-primary/20 group flex items-center justify-between gap-3 rounded-xl px-4 py-3 transition-colors"
      >
        <span className="flex items-center gap-2.5 text-sm font-medium">
          <StatusBadge tone="online" label="Online" />
          <span className="mono-data">{arrived.name}</span> joined the swarm.
        </span>
        <span className="text-primary inline-flex items-center gap-1 text-sm font-bold">
          Open node
          <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
    );
  }
  return (
    <div className="bg-ink-foreground/5 flex items-center gap-3 rounded-xl px-4 py-3">
      <span className={cn('pulse-dot bg-status-progress')} />
      <span className="text-ink-foreground/70 text-sm">Waiting for your node to connect…</span>
    </div>
  );
}
