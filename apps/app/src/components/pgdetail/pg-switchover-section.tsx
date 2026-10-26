import * as React from 'react';
import { Button } from '@swarmy/ui';
import { Depth, Section, StatusWord, Tech } from '@/components/calm';
import { bytes } from '@/lib/format';
import { PgSwitchoverConfirm } from './pg-switchover-confirm';
import { PgSwitchoverProgress } from './pg-switchover-progress';
import type { PgDetailData } from './use-pg-detail';
import { usePgSwitchover } from './use-pg-switchover';

/**
 * "Make this copy the writer" (board 39, at Controls): every standby copy by
 * its server, with whether it can take the writes now (the shared plan) or
 * why not, a confirm that says what happens, and the run's progress card.
 */
export function PgSwitchoverSection({ stack, d }: { stack: string; d: PgDetailData }): React.JSX.Element | null {
  const c = d.cluster!;
  const sw = usePgSwitchover(stack, c, d.place, true);
  const [picked, setPicked] = React.useState<string | null>(null);
  const standbys = c.members.filter((m) => m.role === 'replica' && m.desired > 0);
  if (standbys.length === 0 && !sw.run) return null;
  const choose = (service: string) => setPicked((p) => (p === service ? null : service));
  return (
    <Depth at="controls">
      <Section
        title="Make another copy the writer"
        hint={sw.running ? <StatusWord tone="info" word="switching now" /> : undefined}
      >
        {sw.run ? <PgSwitchoverProgress run={sw.run} copyName={sw.copyName} /> : null}
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Hand the writes to a standby copy that is caught up, say before you work on the main copy’s server. Writes pause for a few seconds; nothing is lost.
        </p>
        <div className="flex flex-col">
          {standbys.map((m) => {
            const plan = sw.plan(m.service);
            const name = sw.copyName(m.service);
            return (
              <div key={m.service} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <b className="text-[13.5px] font-semibold">{name}</b>
                  <span className="text-muted-foreground text-[12.5px]">
                    {plan === null ? 'Asking the main copy how far behind it is…' : plan.ok ? `Caught up (${bytes(plan.behindBytes)} behind): it can take the writes.` : plan.reason}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  aria-expanded={picked === m.service}
                  disabled={!plan?.ok || sw.running || sw.starting}
                  onClick={() => choose(m.service)}
                >
                  Make this copy the writer
                </Button>
              </div>
            );
          })}
        </div>
        {picked ? (
          <PgSwitchoverConfirm
            question={`Make ${sw.copyName(picked)} the writer?`}
            plan={sw.plan(picked)}
            copyName={sw.copyName}
            readError={sw.readError}
            starting={sw.starting}
            onConfirm={() => {
              sw.start(picked);
              setPicked(null);
            }}
            onCancel={() => setPicked(null)}
          />
        ) : null}
        <Tech>
          db.switchover · refused unless the copy is alone in its service, streaming and within 16 MB, and no app connects straight to the main copy (the pooler follows the
          writer) · gate data.failover · audited db.switchover
        </Tech>
      </Section>
    </Depth>
  );
}
