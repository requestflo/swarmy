import * as React from 'react';
import { UserRoundIcon } from 'lucide-react';
import type { IncidentOwnerView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { holdWords, KEEP_LABEL, TAKE_LABEL } from '@/components/incidents/hold-words';
import { useIncidentHold } from '@/components/incidents/use-incident-hold';

/**
 * Who has the incident, on the phone: "Sam has this until 14:32." with Take
 * over, "You have this until 14:32." with 30 more min / Let go, or nobody yet
 * with Take it for 30 min. The hold lapses by itself, so nobody is stuck.
 */
export function GlanceHold({ incidentId, owner }: { incidentId: string; owner: IncidentOwnerView | null }): React.JSX.Element {
  const hold = useIncidentHold(incidentId);
  const words = holdWords(owner) ?? 'Nobody has this yet.';
  const btn = 'h-11 px-3 text-[13px]';
  return (
    <div className="border-border flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t pt-3">
      <p className="text-foreground/85 flex min-w-0 items-center gap-2 text-[13.5px] leading-snug">
        <UserRoundIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <span>{words}</span>
      </p>
      <div className="-my-1.5 flex shrink-0 gap-1">
        {!owner ? (
          <Button variant="outline" size="sm" className={btn} disabled={hold.busy} onClick={() => hold.take()}>
            {TAKE_LABEL}
          </Button>
        ) : owner.mine ? (
          <>
            <Button variant="ghost" size="sm" className={btn} disabled={hold.busy} onClick={() => hold.take()}>
              {KEEP_LABEL}
            </Button>
            <Button variant="ghost" size="sm" className={btn} disabled={hold.busy} onClick={hold.release}>
              Let go
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" className={btn} disabled={hold.busy} onClick={() => hold.take(true)}>
            Take over
          </Button>
        )}
      </div>
    </div>
  );
}
