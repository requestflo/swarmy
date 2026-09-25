import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, NextAction, Say } from '@/components/calm';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { AckButton } from './ack-button';
import { alertsCode } from './alerts-code';
import { ChannelsPanel } from './channels-panel';
import { FiringEvents } from './firing-events';
import { RulesTable } from './rules-table';

/** Activity → Alerts: what's firing (ack), what swarmy watches, and where alerts go. */
export function AlertsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [addOpen, setAddOpen] = React.useState(false);
  const overview = useQuery({ ...trpc.alerts.overview.queryOptions(), refetchInterval: 10_000 });
  const firing = useQuery({ ...trpc.alerts.events.queryOptions({ status: 'firing', limit: 100 }), refetchInterval: 10_000 });
  const rules = useQuery(trpc.alerts.rules.queryOptions());
  const channels = useQuery(trpc.alerts.channels.queryOptions());
  const o = overview.data;
  const top = firing.data?.[0];

  const title = !o ? (
    'Alerts.'
  ) : o.firing === 0 ? (
    <>
      All quiet. <em>{plural(o.rulesEnabled, 'rule')} watching.</em>
    </>
  ) : (
    <>
      <Say tone={o.firingCritical > 0 ? 'bad' : 'warn'}>{plural(o.firing, 'alert')} firing.</Say>{' '}
      {o.firingCritical > 0 ? <em>{o.firingCritical} critical.</em> : <em>Nothing critical.</em>}
    </>
  );
  const lede = o
    ? `${plural(o.rulesEnabled, 'rule')} on of ${o.rules}, going to ${plural(o.channels, 'channel')}. ${plural(o.resolved24h, 'alert')} resolved in the last day.`
    : undefined;

  const next = !o ? null : o.channels === 0 ? (
    <NextAction
      title="Alerts don’t reach anyone yet."
      tech="alerts.createChannel · email · slack · teams · discord · telegram · ntfy · gotify · webhook"
      actions={
        <Button className="pointer-coarse:min-h-11" onClick={() => setAddOpen(true)}>
          <PlusIcon className="size-4" /> Add where alerts go
        </Button>
      }
    >
      Add an email, Slack or a webhook and send it a test. Secrets are encrypted and never shown again.
    </NextAction>
  ) : top ? (
    <NextAction
      title={top.message}
      since={new Date(top.firedAt).toTimeString().slice(0, 5)}
      tech={`${top.signal} · ${top.resource} · ${top.severity}`}
      actions={<AckButton id={top.id} label="Acknowledge" primary size="default" />}
    >
      Acknowledging says someone has it and stops the reminders. The rule keeps watching.
    </NextAction>
  ) : null;

  return (
    <RowPage
      title={title}
      description={lede}
    >
      <CodeView title="Alerting as code" tabs={alertsCode(rules.data ?? [], channels.data ?? [])} source="readonly" />
      {next}
      <FiringEvents />
      <ChannelsPanel open={addOpen} onOpenChange={setAddOpen} />
      <RulesTable />
    </RowPage>
  );
}
