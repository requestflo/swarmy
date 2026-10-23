import * as React from 'react';
import { BoxIcon, DatabaseIcon, GlobeIcon, HammerIcon, HexagonIcon, HardDriveIcon, LockIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { NodeSummary } from '@swarmy/core';

interface Badge {
  key: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  className: string;
}

/** A server's roles and reachability as small icon badges (board 11), each with its words. */
export function badgesOf(n: NodeSummary, nat: boolean): Badge[] {
  const out: Badge[] = [];
  if (n.ingress) out.push({ key: 'edge', icon: GlobeIcon, label: 'Front door: serves visitors', className: 'text-primary' });
  if (n.role === 'manager') out.push({ key: 'ctrl', icon: HexagonIcon, label: 'Controller: runs swarmy', className: 'text-foreground' });
  else out.push({ key: 'worker', icon: BoxIcon, label: 'Worker: runs apps', className: 'text-tone-info' });
  if (n.database) out.push({ key: 'db', icon: DatabaseIcon, label: 'Databases live here', className: 'text-tone-ok' });
  if (n.storage) out.push({ key: 'files', icon: HardDriveIcon, label: 'Holds files', className: 'text-tone-ok' });
  if (n.builder) out.push({ key: 'build', icon: HammerIcon, label: 'Builds apps', className: 'text-muted-foreground' });
  if (nat) out.push({ key: 'nat', icon: LockIcon, label: 'Behind a router: private network only', className: 'text-tone-mesh' });
  return out;
}

export function FleetBadges({ node, nat, className }: { node: NodeSummary; nat: boolean; className?: string }): React.JSX.Element {
  return (
    <ul aria-label="Roles" className={cn('flex items-center gap-1', className)}>
      {badgesOf(node, nat).map((b) => (
        <li key={b.key} title={b.label} className="bg-foreground/[0.06] grid size-[18px] place-items-center rounded-[5px]">
          <b.icon aria-hidden className={cn('size-3', b.className)} />
          <span className="sr-only">{b.label}</span>
        </li>
      ))}
    </ul>
  );
}
