import * as React from 'react';
import { Button } from '@swarmy/ui';
import { useIsOrgAdmin } from '@/components/rum/use-rum';
import type { DomainDetail } from '@/components/ingress/domain-state';
import { cadenceCopy } from './lifecycle';
import type { DomainVerify } from './use-domain-verify';

/** The check cadence (matches `nextCheckDelay`) and, for admins, the audited DNS-check skip. */
export function VerifyFooter({ d, v }: { d: DomainDetail; v: DomainVerify }): React.JSX.Element {
  const admin = useIsOrgAdmin();
  const [asking, setAsking] = React.useState(false);
  const canSkip = admin && d.verifiedAt === null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground flex items-start gap-2 text-[12.5px] leading-relaxed">
        <span aria-hidden className="bg-status-progress mt-1.5 size-1.5 shrink-0 rounded-full" />
        {cadenceCopy(d.state, d.verifiedAt !== null)}
      </p>
      {d.verifiedManually ? (
        <p className="text-muted-foreground font-mono text-[11.5px]">DNS check skipped by an admin · recorded in the audit log</p>
      ) : null}
      {canSkip && !asking ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" onClick={() => setAsking(true)} className="text-foreground/80 hover:text-foreground min-h-11 text-left text-[13px] font-medium underline-offset-2 hover:underline">
            Skip DNS check (behind an external load balancer)
          </button>
          <span className="text-muted-foreground font-mono text-[11px]">admin only · audited</span>
        </div>
      ) : null}
      {canSkip && asking ? (
        <div role="alertdialog" aria-label="Skip the DNS check?" className="calm-card border-status-warning/50 flex flex-col gap-2.5 border px-4 py-3.5">
          <p className="text-[13.5px] font-semibold">Skip the DNS check for {d.host}?</p>
          <p className="text-muted-foreground text-[13px] leading-snug">
            The front door will ask Let’s Encrypt for a certificate even though swarmy can’t see DNS pointing here. Only do this when
            a load balancer or proxy in front of swarmy owns the public address. It’s recorded in the audit log.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setAsking(false)} className="pointer-coarse:min-h-11">Keep checking</Button>
            <Button
              variant="outline"
              disabled={v.skipping}
              onClick={() => {
                v.skip();
                setAsking(false);
              }}
              className="text-tone-warn pointer-coarse:min-h-11"
            >
              {v.skipping ? 'Skipping…' : 'Skip the check'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
