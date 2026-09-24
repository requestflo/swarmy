import * as React from 'react';
import { Chip } from './rum-ui';
import { countryName, hhmm, type ReplayDetail } from './rum-shared';
import { DeleteSessionButton } from './delete-session-button';

interface ReplayHeaderProps {
  stack: string;
  detail: ReplayDetail;
  linked: boolean;
  admin: boolean;
}

/** Which visit this is, what the recording guarantees, and the GDPR erase. */
export function ReplayHeader({ stack, detail, linked, admin }: ReplayHeaderProps): React.JSX.Element {
  const m = detail.meta;
  const who = [m?.browser, m?.device, m?.country ? countryName(m.country) : ''].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm font-semibold">session {detail.sessionId.slice(0, 10)}</span>
      {linked ? <Chip tone="progress">linked by traceparent</Chip> : null}
      <Chip tone="online">inputs masked</Chip>
      {who ? <Chip>{who}</Chip> : null}
      {m?.userId ? <Chip mono>{m.userId}</Chip> : null}
      <span className="text-muted-foreground ml-auto font-mono text-xs">
        {m?.startedAt ? `started ${hhmm(m.startedAt)}` : null}
      </span>
      {admin ? <DeleteSessionButton stack={stack} sessionId={detail.sessionId} /> : null}
    </div>
  );
}
