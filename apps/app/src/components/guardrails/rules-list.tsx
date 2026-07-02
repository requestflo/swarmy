import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GuardrailRuleView, GuardrailsConfigView, SetGuardrailRuleInput } from '@swarmy/core';
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { RULE_COPY } from './rule-copy';

function RuleRow({
  rule,
  forced,
  busy,
  onChange,
}: {
  rule: GuardrailRuleView;
  /** Safety mode is ON — prod deploys enforce this rule at block regardless. */
  forced: boolean;
  busy: boolean;
  onChange: (patch: Omit<SetGuardrailRuleInput, 'id'>) => void;
}): React.JSX.Element {
  const copy = RULE_COPY[rule.id];
  const paramValue = copy.paramKey ? (rule.params[copy.paramKey] ?? 0) : null;

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{copy.title}</span>
          {rule.prodOnly ? <StatusBadge tone="neutral" label="prod only" /> : null}
          {forced ? <StatusBadge tone="progress" label="forced block in prod" /> : null}
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">{copy.description}</p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {copy.paramKey && paramValue !== null ? (
          <label className="flex items-center gap-1.5">
            <span className="mono-label !mb-0">{copy.paramLabel}</span>
            <Input
              type="number"
              min={0}
              max={10}
              value={paramValue}
              disabled={busy}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 0) onChange({ params: { [copy.paramKey!]: n } });
              }}
              className="h-8 w-16 text-center"
            />
          </label>
        ) : null}
        <Select
          value={rule.severity}
          onValueChange={(v) => onChange({ severity: v as 'block' | 'warn' })}
          disabled={busy}
        >
          <SelectTrigger className="h-8 w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="block">Block</SelectItem>
            <SelectItem value="warn">Warn</SelectItem>
          </SelectContent>
        </Select>
        <Switch
          checked={rule.enabled}
          disabled={busy}
          onCheckedChange={(v) => onChange({ enabled: v })}
        />
      </div>
    </div>
  );
}

/** The rules card: every guardrail with toggle, severity and params. */
export function RulesList({ config }: { config: GuardrailsConfigView }): React.JSX.Element {
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
    <section className="card-pop overflow-hidden">
      <header className="border-border border-b px-5 py-3">
        <span className="mono-label !mb-0">Rules</span>
        <p className="text-muted-foreground text-xs">
          Checked on every deploy. Block = refused (admin override); warn = refused but any member
          can override. Prod-only rules apply to stacks marked production.
        </p>
      </header>
      <div className="divide-border divide-y">
        {config.rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            forced={config.productionSafetyMode}
            busy={setRule.isPending}
            onChange={(patch) => setRule.mutate({ id: rule.id, ...patch })}
          />
        ))}
      </div>
    </section>
  );
}
