import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdmissionTallyView, GuardrailRuleView, GuardrailsConfigView, SetGuardrailRuleInput } from '@swarmy/core';
import { Input, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Depth, Section, Tech } from '@/components/calm';
import { RULE_COPY } from './rule-copy';
import { RuleLevelSwitch, type RuleLevel } from './rule-level';
import { ruleRecord, type RuleRecordTone } from './rule-history';

const RECORD_TONE: Record<RuleRecordTone, string> = { ok: 'text-tone-ok', warn: 'text-tone-warn', idle: 'text-muted-foreground' };

function RuleRow({ rule, forced, busy, tally, tallyFailed, onChange }: {
  rule: GuardrailRuleView;
  forced: boolean;
  busy: boolean;
  /** The admission receipts; undefined while they load. */
  tally: AdmissionTallyView | undefined;
  tallyFailed: boolean;
  onChange: (patch: Omit<SetGuardrailRuleInput, 'id'>) => void;
}): React.JSX.Element {
  const copy = RULE_COPY[rule.id];
  const level: RuleLevel = rule.enabled ? rule.severity : 'off';
  const record = tally ? ruleRecord(rule, forced, tally) : null;
  const paramValue = copy.paramKey ? (rule.params[copy.paramKey] ?? 0) : null;
  return (
    <div className="border-border flex flex-wrap items-start gap-x-4 gap-y-2 border-b px-1 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <span className="text-[14.5px] font-semibold">{copy.title}</span>
        <span className="text-muted-foreground text-[13px]">{copy.description}</span>
        {record ? (
          <span className={cn('text-[12.5px]', RECORD_TONE[record.tone])}>{record.line}</span>
        ) : tallyFailed ? (
          <span className="text-muted-foreground text-[12.5px]">Its 30-day record didn’t load.</span>
        ) : (
          <span aria-hidden className="shimmer-line my-0.5 h-3.5 w-64 max-w-full rounded" />
        )}
        <Tech>{`${rule.id}${rule.prodOnly ? ' · apps labelled swarmy.env=production only' : ''}${forced ? ' · safety mode forces block in production' : ''}`}</Tech>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {copy.paramKey && paramValue !== null ? (
          <Depth at="controls">
            <label className="flex items-center gap-1.5 text-xs font-semibold">
              {copy.paramLabel}
              <Input type="number" min={0} max={10} value={paramValue} disabled={busy} className="h-8 w-16 text-center" onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 0) onChange({ params: { [copy.paramKey!]: n } });
              }} />
            </label>
          </Depth>
        ) : null}
        <RuleLevelSwitch label={copy.title} value={level} disabled={busy} onChange={(v) => onChange(v === 'off' ? { enabled: false } : { enabled: true, severity: v })} />
      </div>
    </div>
  );
}

/** Every guardrail as Block · Warn · Off, with what it did (or, at Warn and Off, what Block would have done) in the last 30 days. */
export function RulesList({ config, tally, tallyFailed = false }: { config: GuardrailsConfigView; tally: AdmissionTallyView | undefined; tallyFailed?: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const setRule = useMutation(
    trpc.guardrails.setRule.mutationOptions({
      onSuccess: () => {
        toast.success('Guardrail updated');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Section title="Guardrails" hint="checked on every deploy, by anyone: people, CI and Terraform alike" flush>
      <p className="text-muted-foreground pb-1 text-[13px]">Block refuses the deploy (an admin can override). Warn asks, and anyone can push through. Every decision is on the record, so Warn and Off rules can say what Block would have stopped.</p>
      {config.rules.map((rule) => (
        <RuleRow key={rule.id} rule={rule} forced={config.productionSafetyMode} busy={setRule.isPending} tally={tally} tallyFailed={tallyFailed} onChange={(patch) => setRule.mutate({ id: rule.id, ...patch })} />
      ))}
    </Section>
  );
}
