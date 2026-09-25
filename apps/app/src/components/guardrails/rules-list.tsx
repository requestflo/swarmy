import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GuardrailDecisionView, GuardrailRuleView, GuardrailsConfigView, SetGuardrailRuleInput } from '@swarmy/core';
import { Input, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Depth, Section, Tech } from '@/components/calm';
import { RULE_COPY } from './rule-copy';
import { RuleLevelSwitch, type RuleLevel } from './rule-level';
import { ruleHistory } from './rule-history';

function RuleRow({ rule, forced, busy, decisions, onChange }: {
  rule: GuardrailRuleView;
  forced: boolean;
  busy: boolean;
  decisions: GuardrailDecisionView[];
  onChange: (patch: Omit<SetGuardrailRuleInput, 'id'>) => void;
}): React.JSX.Element {
  const copy = RULE_COPY[rule.id];
  const level: RuleLevel = rule.enabled ? rule.severity : 'off';
  const hist = ruleHistory(rule.id, decisions);
  const paramValue = copy.paramKey ? (rule.params[copy.paramKey] ?? 0) : null;
  return (
    <div className="border-border flex flex-wrap items-start gap-x-4 gap-y-2 border-b px-1 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <span className="text-[14.5px] font-semibold">{copy.title}</span>
        <span className="text-muted-foreground text-[13px]">{copy.description}</span>
        <span className={cn('text-[12.5px]', hist.stopped ? 'text-tone-ok' : hist.hits ? 'text-tone-warn' : 'text-muted-foreground')}>{hist.line}</span>
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

/** Every guardrail as Block · Warn · Off, with what it did in the last 30 days. */
export function RulesList({ config, decisions }: { config: GuardrailsConfigView; decisions: GuardrailDecisionView[] }): React.JSX.Element {
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
      <p className="text-muted-foreground pb-1 text-[13px]">Block refuses the deploy (an admin can override). Warn asks, and anyone can push through. Every block and override is on the record.</p>
      {config.rules.map((rule) => (
        <RuleRow key={rule.id} rule={rule} forced={config.productionSafetyMode} busy={setRule.isPending} decisions={decisions} onChange={(patch) => setRule.mutate({ id: rule.id, ...patch })} />
      ))}
    </Section>
  );
}
