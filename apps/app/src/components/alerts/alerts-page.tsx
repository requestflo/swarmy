import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Say } from '@/components/calm';
import { RowPage } from '@/components/rowpage/row-page';
import { CardSkeleton, ErrorState } from '@/components/states';
import { alertsLede, alertsSay } from './alerts-say';
import { ChannelsColumn } from './channels-column';
import { RuleEditor } from './rule-editor';
import { RulesList, orderRules } from './rules-list';
import { useAlertsData } from './use-alerts-data';

type Selection = { mode: 'edit'; id: string } | { mode: 'new' } | null;

/**
 * Activity → Alerts (boards 45 + 55): the rules list, the sentence editor and
 * the channels, side by side at xl, two columns at lg, stacked on a phone.
 * The one coral is "New rule" — until the editor holds unsaved changes, when
 * "Save rule" takes it and New rule steps back to outline.
 */
export function AlertsPage(): React.JSX.Element {
  const data = useAlertsData();
  const [sel, setSel] = React.useState<Selection>(null);
  const [dirty, setDirty] = React.useState(false);
  const o = data.overview;
  const firing = data.events.filter((e) => e.status === 'firing');

  const fallback = orderRules(data.rules, data.firingByRule)[0];
  const selectedId = sel?.mode === 'edit' && data.rules.some((r) => r.id === sel.id) ? sel.id : sel?.mode === 'new' ? null : fallback?.id ?? null;
  const selected = data.rules.find((r) => r.id === selectedId);
  const isNew = sel?.mode === 'new' || (!selected && data.ready);

  const say = o ? alertsSay(o, firing) : null;
  const title = !say ? 'Alerts.' : say.alarm ? (
    <>
      <Say tone={say.alarm.tone}>{say.alarm.text}</Say> {say.rest ? <em>{say.rest}</em> : null}
    </>
  ) : (
    <>
      {say.lead} <em>{say.rest}</em>
    </>
  );

  const startNew = (): void => {
    setDirty(false);
    setSel({ mode: 'new' });
    toEditorOnPhone();
  };

  return (
    <RowPage
      title={title}
      description={o ? alertsLede(o) : undefined}
      actions={
        <Button variant={dirty ? 'outline' : 'default'} className="pointer-coarse:min-h-11" onClick={startNew}>
          <PlusIcon className="size-4" /> New rule
        </Button>
      }
    >
      {data.error && !data.ready ? (
        <ErrorState title="Couldn’t load the alert rules." error={data.error} retry={data.refetch} />
      ) : !data.ready ? (
        <CardSkeleton />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)_minmax(0,340px)]">
          <RulesList
            rules={data.rules}
            channels={data.channels}
            events={data.events}
            firingByRule={data.firingByRule}
            selectedId={isNew ? null : selectedId}
            onSelect={(id) => {
              setDirty(false);
              setSel({ mode: 'edit', id });
              toEditorOnPhone();
            }}
          />
          <RuleEditor
            key={isNew ? 'new' : selectedId ?? 'none'}
            rule={isNew ? null : selected ?? null}
            data={data}
            onDirtyChange={setDirty}
            onSaved={(id) => {
              setDirty(false);
              setSel({ mode: 'edit', id });
            }}
            onDeleted={() => {
              setDirty(false);
              setSel(null);
            }}
          />
          <ChannelsColumn channels={data.channels} rules={data.rules} rule={isNew ? null : selected ?? null} className="lg:col-span-2 xl:col-span-1" />
        </div>
      )}
    </RowPage>
  );
}

/** Below lg the editor sits under the list, so bring it into view on select. */
function toEditorOnPhone(): void {
  if (!window.matchMedia('(max-width: 1023px)').matches) return;
  requestAnimationFrame(() => document.getElementById('rule-editor')?.scrollIntoView({ block: 'start' }));
}
