import * as React from 'react';
import { ALERT_SIGNAL_INFO, type AlertRuleView, type AlertSignal, type NotificationChannelView, type UpdateAlertRuleInput } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_TEXT, type Tone } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { flipRoute } from './events-route';
import { DURATION_PRESETS, formatDuration, formatValue, phraseFor } from './signal-phrases';

const LEVEL_TONE: Record<string, Tone> = { critical: 'bad', warning: 'warn', info: 'info' };

const pill = (on: boolean, via = false): string =>
  cn(
    'h-7 rounded-md border px-2 font-mono text-[11.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 pointer-coarse:min-h-11',
    on ? 'bg-foreground text-background border-foreground' : via ? 'bg-accent text-foreground border-border' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
  );

/** "for 5 min" · "right away". */
const held = (s: number): string => (s > 0 ? `for ${formatDuration(s)}` : 'right away');

/** The next preset after `v` (or the first when `v` isn't one). */
const next = <T,>(list: readonly T[], v: T): T => list[(list.indexOf(v) + 1) % list.length]!;

interface EventsTableRowProps {
  rule: AlertRuleView;
  channels: NotificationChannelView[];
  busy: boolean;
  onChange: (patch: UpdateAlertRuleInput, said: string) => void;
}

/** Rule · threshold (click to step) · level · route (All or picked channels) · on. */
export function EventsTableRow({ rule, channels, busy, onChange }: EventsTableRowProps): React.JSX.Element {
  const p = phraseFor(rule.signal);
  const level = ALERT_SIGNAL_INFO[rule.signal as AlertSignal]?.severity ?? 'warning';
  const live = channels.filter((c) => c.enabled).map((c) => c.id);
  const all = rule.channelIds.length === 0;
  const gets = (id: string): boolean => (all ? live.includes(id) : rule.channelIds.includes(id));

  // The knob a click steps: the threshold, or — for a held event — how long it must last.
  const knob =
    p.op !== null
      ? { label: `${p.op} ${formatValue(rule.signal, rule.threshold)}`, step: () => next(p.presets, rule.threshold ?? NaN), field: 'threshold' as const }
      : p.held
        ? { label: held(rule.forSeconds), step: () => next(DURATION_PRESETS, rule.forSeconds as (typeof DURATION_PRESETS)[number]), field: 'forSeconds' as const }
        : null;
  const sub = p.op !== null ? `${p.metric}${p.held && rule.forSeconds > 0 ? ` · ${held(rule.forSeconds)}` : ''}` : null;

  const flip = (id: string): void => {
    const channelIds = flipRoute(rule.channelIds, live, id);
    const name = channels.find((c) => c.id === id)?.name ?? 'that channel';
    onChange({ id: rule.id, channelIds }, channelIds.length === 0 ? 'goes to every channel' : `${gets(id) ? 'no longer goes to' : 'now goes to'} ${name}`);
  };

  return (
    // Phone: name + switch on one line, then the level and the route; md+: the four columns.
    <li className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-2.5 md:grid-cols-[minmax(0,1.3fr)_72px_minmax(0,1.6fr)_44px]', !rule.enabled && 'opacity-60')}>
      <div className="order-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13.5px] font-semibold">{rule.name}</span>
        {knob ? (
          <button
            type="button"
            disabled={busy}
            aria-label={`${rule.name}: ${knob.label}. Change it`}
            className="border-border hover:bg-accent rounded-md border border-dashed px-1.5 font-mono text-[11.5px] pointer-coarse:min-h-11"
            onClick={() => {
              const v = knob.step();
              onChange({ id: rule.id, [knob.field]: v }, knob.field === 'threshold' ? `now ${p.op} ${formatValue(rule.signal, v)}` : `now ${held(v)}`);
            }}
          >
            {knob.label}
          </button>
        ) : null}
        {sub ? <span className="text-muted-foreground w-full font-mono text-[11px]">{sub}</span> : null}
      </div>
      <span className={cn('order-3 col-span-2 font-mono text-[11.5px] font-semibold md:order-2 md:col-span-1', TONE_TEXT[LEVEL_TONE[level] ?? 'warn'])}>{level}</span>
      <div className="order-4 col-span-2 flex flex-wrap items-center gap-1.5 md:order-3 md:col-span-1" role="group" aria-label={`Where ${rule.name} goes`}>
        <button type="button" disabled={busy} aria-pressed={all} className={pill(all)} onClick={() => !all && onChange({ id: rule.id, channelIds: [] }, 'goes to every channel')}>
          All
        </button>
        {channels.map((c) => {
          const on = gets(c.id);
          return (
            <button key={c.id} type="button" disabled={busy || (!c.enabled && !on)} aria-pressed={on} aria-label={`${c.name} gets ${rule.name}`} className={pill(on && !all, on && all)} onClick={() => flip(c.id)}>
              {c.name}
            </button>
          );
        })}
      </div>
      <QuietSwitch className="order-2 md:order-4" checked={rule.enabled} disabled={busy} aria-label={`${rule.name} on`} onCheckedChange={(enabled) => onChange({ id: rule.id, enabled }, enabled ? 'on' : 'off')} />
    </li>
  );
}
