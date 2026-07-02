import * as React from 'react';
import { CrownIcon, ServerIcon } from 'lucide-react';
import { StatusBadge, cn, type StatusTone } from '@swarmy/ui';
import { DB_LAG_WARN_SECONDS, type DbClusterMemberView } from '@swarmy/core';

/** Live member status → a status token. `absent` reads as offline. */
export function memberTone(status: DbClusterMemberView['status']): StatusTone {
  if (status === 'running') return 'online';
  if (status === 'degraded') return 'warning';
  if (status === 'deploying') return 'progress';
  if (status === 'absent' || status === 'stopped') return 'offline';
  return 'neutral';
}

/**
 * Replication-lag pill for one member (seconds behind the writer, stamped by
 * the reconcile as `swarmy.db.lag.<member>`). Quiet green while in sync, amber
 * once it crosses the warn threshold — numbers are heroes, so mono.
 */
export function LagBadge({ seconds }: { seconds: number }): React.JSX.Element {
  const warn = seconds > DB_LAG_WARN_SECONDS;
  return (
    <span
      className={cn(
        'mono-data rounded-full px-2 py-0.5 text-[11px] font-bold',
        warn ? 'bg-status-warning/12 text-status-warning' : 'bg-status-online/12 text-status-online',
      )}
      title={warn ? `Replica is ${seconds}s behind the writer` : 'Replication lag'}
    >
      {warn ? `lag ${seconds}s` : `${seconds}s`}
    </span>
  );
}

const ROLE_LABEL: Record<DbClusterMemberView['role'], string> = {
  primary: 'primary · writer',
  replica: 'replica · read',
  dcs: 'dcs · consensus',
};

function MemberRow({
  member,
  isLeader,
}: {
  member: DbClusterMemberView;
  isLeader: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ServerIcon className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0">
          <p className="mono-label text-muted-foreground !mb-0 flex items-center gap-1 !text-[10px]">
            {ROLE_LABEL[member.role]}
            {member.region ? <span className="text-muted-foreground/70">· {member.region}</span> : null}
          </p>
          <span className="flex min-w-0 items-center gap-1.5">
            <code className="mono-data block truncate text-xs">{member.service}</code>
            {isLeader && (
              <CrownIcon
                className="text-primary size-3.5 shrink-0"
                aria-label="Current leader (single writer)"
              />
            )}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {member.lagSeconds !== undefined && <LagBadge seconds={member.lagSeconds} />}
        <span className="mono-data text-muted-foreground text-[11px]">
          {member.running}/{member.desired}
        </span>
        <StatusBadge tone={memberTone(member.status)} label={member.status} />
      </div>
    </div>
  );
}

/**
 * Per-member topology rows for a managed Postgres cluster: role, region pin,
 * live health, running/desired tasks, replication-lag badge and a coral crown
 * on the leader (`swarmy.db.leader`). Flat rows in one frame, hairline-divided.
 */
export function DbMemberList({
  members,
  leader,
}: {
  members: DbClusterMemberView[];
  leader?: string;
}): React.JSX.Element {
  if (members.length === 0) {
    return (
      <div className="border-border/60 text-muted-foreground mono-label !mb-0 rounded-lg border border-dashed px-3 py-4 text-center !text-[11px]">
        No live members — the cluster is still converging
      </div>
    );
  }
  return (
    <div className="border-border divide-border divide-y rounded-lg border">
      {members.map((m) => (
        <MemberRow key={m.service} member={m} isLeader={m.service === leader} />
      ))}
    </div>
  );
}
