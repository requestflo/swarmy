import * as React from 'react';
import { ServerIcon } from 'lucide-react';
import type { CacheMemberView } from '@swarmy/core';
import { StatusBadge, type StatusTone } from '@swarmy/ui';

function memberTone(status: CacheMemberView['status']): StatusTone {
  if (status === 'running') return 'online';
  if (status === 'degraded') return 'warning';
  if (status === 'deploying') return 'progress';
  if (status === 'absent' || status === 'stopped') return 'offline';
  return 'neutral';
}

const ROLE_LABEL: Record<CacheMemberView['role'], string> = {
  primary: 'primary · writer',
  replica: 'replica · read pool',
  sentinel: 'sentinel · failover quorum',
};

/** Flat member rows (one card, hairline-divided) — roles, counts, health. */
export function CacheMembersList({ members }: { members: CacheMemberView[] }): React.JSX.Element {
  return (
    <div className="border-border divide-border divide-y rounded-lg border">
      {members.map((m) => (
        <div key={m.service} className="flex items-center justify-between gap-3 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <ServerIcon className="text-muted-foreground size-4 shrink-0" />
            <div className="min-w-0">
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">
                {ROLE_LABEL[m.role]}
                {m.region ? ` · ${m.region}` : ''}
              </p>
              <code className="mono-data block truncate text-xs">{m.service}</code>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="mono-data text-sm">
              {m.running}
              <span className="text-muted-foreground"> / {m.desired}</span>
            </span>
            <StatusBadge tone={memberTone(m.status)} label={m.status} />
          </div>
        </div>
      ))}
    </div>
  );
}
