import * as React from 'react';
import type { AlertRuleView } from '@swarmy/core';
import { Input } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { AckButton } from './ack-button';
import { RuleEditorFooter } from './rule-editor-footer';
import { evaluatorKey, rawExpression } from './rule-facts';
import { RuleHistoryChart } from './rule-history-chart';
import { RuleKnobs } from './rule-knobs';
import { resourceName } from './rule-sentence';
import { SentenceTokens } from './sentence-tokens';
import type { AlertsData } from './use-alerts-data';
import { useAlertTargets } from './use-alert-targets';
import { draftForSignal, useRuleDraft } from './use-rule-draft';

interface RuleEditorProps {
  rule: AlertRuleView | null;
  data: AlertsData;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}

/** The sentence editor, for an existing rule and for New rule alike. */
export function RuleEditor({ rule, data, onDirtyChange, onSaved, onDeleted }: RuleEditorProps): React.JSX.Element {
  const d = useRuleDraft(rule, onSaved, onDeleted);
  const uid = React.useId();
  const ids = { value: `${uid}-v`, duration: `${uid}-d`, channels: `${uid}-c` };
  React.useEffect(() => onDirtyChange(d.dirty), [d.dirty, onDirtyChange]);
  const targets = useAlertTargets();
  const firing = rule ? data.firingByRule.get(rule.id) ?? [] : [];
  const siblings = data.rules.filter((r) => r.signal === d.draft.signal && r.enabled && r.id !== rule?.id).length;
  const nameTouched = d.draft.name !== draftForSignal(d.draft.signal).name;

  return (
    <section id="rule-editor" aria-label={rule ? `Editing ${rule.name}` : 'New rule'} className="flex min-w-0 scroll-mt-4 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">{rule ? 'Editing' : 'New rule'}</span>
          {rule ? <h2 className="font-display truncate text-[22px] font-bold tracking-[-0.02em]">{d.draft.name || rule.name}</h2> : null}
        </div>
        <Depth at="controls">
          <label className="flex items-center gap-2 text-sm">
            <QuietSwitch checked={d.draft.enabled} onCheckedChange={(enabled) => d.patch({ enabled })} aria-label="Rule on" />
            {d.draft.enabled ? 'On' : 'Off'}
          </label>
        </Depth>
      </div>

      {firing.length ? (
        <div className="bg-status-offline/10 flex flex-col items-start gap-1 rounded-lg px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-2">
          <span className="text-tone-bad font-semibold">Firing now</span>
          <span className="text-muted-foreground min-w-0 sm:flex-1">{firing[0]?.message}</span>
          {firing[0] ? <AckButton id={firing[0].id} label="Acknowledge" /> : null}
        </div>
      ) : null}

      <div className="calm-card flex flex-col gap-4 px-5 py-4">
        {rule ? (
          <Depth at="controls">
            <Input aria-label="Rule name" value={d.draft.name} onChange={(e) => d.patch({ name: e.target.value })} className="max-w-sm" />
          </Depth>
        ) : (
          <Input aria-label="Rule name" value={d.draft.name} onChange={(e) => d.patch({ name: e.target.value })} className="max-w-sm" />
        )}
        <SentenceTokens
          draft={d.draft}
          base={d.base}
          channels={data.channels}
          canPickSignal={!rule}
          onPickSignal={(signal) => d.patch({ ...draftForSignal(signal, d.draft.channelIds), ...(nameTouched ? { name: d.draft.name } : {}) })}
          targets={targets}
          onPickTarget={(selector) => d.patch({ selector })}
          ids={ids}
        />
        <RuleKnobs draft={d.draft} channels={data.channels} patch={d.patch} ids={ids} />
        {siblings > 0 ? (
          <p className="text-muted-foreground text-xs">
            {siblings === 1 ? 'One other rule watches' : `${siblings} other rules watch`} this signal too. Each one alerts on its own, so a
            narrower rule can go somewhere else.
          </p>
        ) : null}
        <Tech>
          {rule ? `rule ${rule.id} · ` : ''}
          {rawExpression(d.draft)} · evaluator key {evaluatorKey(d.draft.signal, rule?.id)}
          {firing.length ? ` · open on ${firing.map((e) => resourceName(e.resource)).join(', ')}` : ''}
        </Tech>
      </div>

      <RuleHistoryChart
        events={data.events}
        signal={d.draft.signal}
        selector={d.draft.selector}
        changed={!rule || d.draft.threshold !== d.base.threshold || d.draft.forSeconds !== d.base.forSeconds}
        pageFull={data.events.length >= 200}
      />

      {/* Board 45's "Who hears about it" escalation chain and "Group related alerts" are left out by owner decision Q10 (e). */}

      <RuleEditorFooter
        rule={rule}
        dirty={d.dirty}
        saving={d.saving}
        removing={d.removing}
        muting={d.muting}
        onSave={d.save}
        onDiscard={d.reset}
        onDelete={d.remove}
        onMute={d.mute}
        onUnmute={d.unmute}
      />
    </section>
  );
}
