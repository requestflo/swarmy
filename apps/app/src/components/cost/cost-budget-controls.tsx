import * as React from 'react';
import type { NotificationChannelView } from '@swarmy/core';
import { Button, Input, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { CostBudgetApi } from './use-cost-budget';

const WARN_PRESETS = [50, 80, 90, 100] as const;

/** Controls depth: the budget amount, warn % presets and who hears about it. */
export function CostBudgetControls({ api }: { api: CostBudgetApi }): React.JSX.Element | null {
  const b = api.budget;
  const uid = React.useId();
  const [draft, setDraft] = React.useState(b?.monthlyUsd != null ? String(b.monthlyUsd) : '');
  React.useEffect(() => setDraft(b?.monthlyUsd != null ? String(b.monthlyUsd) : ''), [b?.monthlyUsd]);
  if (!b) return null;
  const n = draft.trim() === '' ? null : Number(draft);
  const valid = n === null || (Number.isFinite(n) && n >= 1);
  const dirty = n !== b.monthlyUsd;
  return (
    <div className="border-border mt-1 flex flex-col gap-3 border-t pt-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && dirty) api.save({ monthlyUsd: n }, n === null ? 'Budget cleared.' : `Budget set to $${n} a month.`);
        }}
      >
        <label htmlFor={`${uid}-amt`} className="text-muted-foreground text-[13px]">
          Monthly budget
        </label>
        <span className="text-muted-foreground text-sm">$</span>
        <Input id={`${uid}-amt`} inputMode="decimal" value={draft} placeholder="none" onChange={(e) => setDraft(e.target.value)} className="mono-data h-8 w-28 text-right pointer-coarse:h-11" />
        <Button type="submit" variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={!valid || !dirty || api.saving}>
          {api.saving ? 'Saving…' : 'Save budget'}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Warn at">
        <span className="text-muted-foreground text-[13px]">Warn at</span>
        {WARN_PRESETS.map((p) => (
          <Chip key={p} on={b.warnAtPct === p} disabled={api.saving || !b.ruleId} onClick={() => api.save({ warnAtPct: p })}>
            {p}%
          </Chip>
        ))}
      </div>
      <ChannelPicker label="Warn" ids={b.warnChannelIds} channels={api.channels} disabled={api.saving || !b.ruleId} onChange={(warnChannelIds) => api.save({ warnChannelIds })} />
      <ChannelPicker label="Weekly summary to" ids={b.weeklyChannelIds} channels={api.channels} disabled={api.saving} onChange={(weeklyChannelIds) => api.save({ weeklyChannelIds })} />
      <Tech>{`alert rule cost-budget · threshold ${b.warnAtPct}% of budget · resource org:budget · weekly Mon 09:00 ${b.timeZone} · no channel picked = every channel`}</Tech>
    </div>
  );
}

function Chip({ on, children, ...rest }: { on: boolean; children: React.ReactNode } & Omit<React.ComponentProps<'button'>, 'children'>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cn(
        'border-border inline-flex min-h-8 items-center rounded-full border px-3 font-mono text-[12.5px] pointer-coarse:min-h-11 disabled:opacity-50',
        on ? 'bg-foreground text-background border-foreground font-semibold' : 'hover:bg-accent',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Toggle channels on and off; none picked means every enabled channel. */
function ChannelPicker({
  label,
  ids,
  channels,
  disabled,
  onChange,
}: {
  label: string;
  ids: string[];
  channels: NotificationChannelView[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="text-muted-foreground text-[13px]">{label}</span>
      {channels.length === 0 ? <span className="text-muted-foreground text-[13px]">no channels yet — add one on Alerts</span> : null}
      {channels.map((c) => {
        const on = ids.includes(c.id);
        return (
          <Chip key={c.id} on={on} disabled={disabled} onClick={() => onChange(on ? ids.filter((x) => x !== c.id) : [...ids, c.id])}>
            {c.name}
          </Chip>
        );
      })}
    </div>
  );
}
