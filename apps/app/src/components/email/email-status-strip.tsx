import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, CopyButton, StatusBadge, type StatusTone } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EmailSettingsMenu } from './email-settings-menu';
import { TestSendDialog } from './test-send-dialog';
import { useEmailMutationHandlers, type EmailOverviewData } from './use-email';

function mtaTone(m: EmailOverviewData['mta']): { tone: StatusTone; label: string } {
  if (m.running) return { tone: 'online', label: 'Mail server running' };
  if (m.deployed) return { tone: 'progress', label: 'Mail server starting' };
  return { tone: 'progress', label: 'Waiting for a manager node' };
}

function port25(o: EmailOverviewData): { tone: StatusTone; label: string } {
  if (!o.port25) return { tone: 'neutral', label: 'Port 25 not checked yet' };
  if (o.port25.verdict === 'open') return { tone: 'online', label: 'Port 25 open' };
  if (o.port25.verdict === 'blocked') return { tone: 'offline', label: 'Port 25 blocked' };
  return { tone: 'warning', label: 'Port 25 unclear' };
}

/** MTA + delivery-path status, the endpoints apps use, and the page's actions. */
export function EmailStatusStrip({ overview: o }: { overview: EmailOverviewData }): React.JSX.Element {
  const trpc = useTRPC();
  const probe = useMutation(trpc.email.probePort25.mutationOptions(useEmailMutationHandlers('Port 25 checked')));
  const mta = mtaTone(o.mta);
  const p25 = port25(o);
  return (
    <div className="calm-card grid gap-4 p-5 md:grid-cols-[1fr_auto]">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <p className="mono-label text-muted-foreground">Mail server</p>
          <StatusBadge tone={mta.tone} label={mta.label} />
          <p className="mono-data text-muted-foreground text-xs">
            {o.mta.host}:{o.mta.port} · HELO {o.mta.helo}
          </p>
        </div>
        <div className="space-y-1">
          <p className="mono-label text-muted-foreground">Direct delivery</p>
          <StatusBadge tone={p25.tone} label={p25.label} />
          <p className="mono-data text-muted-foreground text-xs">
            {o.mta.nodeIps.length ? `sends from ${o.mta.nodeIps.join(', ')}` : 'mail node IP not known yet'}
          </p>
        </div>
        <div className="min-w-0 space-y-1">
          <p className="mono-label text-muted-foreground">HTTP send API</p>
          <div className="flex items-center gap-1">
            <code className="mono-data truncate text-xs">POST {o.apiUrl}/send</code>
            <CopyButton value={`${o.apiUrl}/send`} />
          </div>
          <p className="text-muted-foreground text-xs">Bearer the app’s EMAIL_API_KEY.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <Button variant="outline" size="sm" disabled={probe.isPending} onClick={() => probe.mutate()}>
          {probe.isPending ? 'Checking…' : 'Check port 25'}
        </Button>
        <TestSendDialog domains={o.domains.filter((d) => d.verifiedAt).map((d) => d.domain)} />
        <EmailSettingsMenu overview={o} />
      </div>
    </div>
  );
}
