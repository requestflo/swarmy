import * as React from 'react';
import { Trash2Icon } from 'lucide-react';
import type { LifecycleRuleView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { AGE_MARKS, agePosition, ruleDoes } from './lifecycle-model';

export interface TimelineRow {
  key: string;
  /** "tmp/", "everything else". */
  where: string;
  /** "deleted after 7 days". */
  label: string;
  /** Days until the rule acts; null = kept forever. */
  days: number | null;
  /** The rule's index (absent on the implicit "everything else" row). */
  index?: number;
  dim?: boolean;
}

/** One row per rule (its earliest action), plus "everything else · kept" when no rule covers the whole bucket. */
export function timelineRows(rules: readonly LifecycleRuleView[]): TimelineRow[] {
  const rows: TimelineRow[] = rules.map((r, i) => ({
    key: r.id ?? `rule-${i}`,
    where: r.prefix || (r.expireAfterDays === null && r.expireOnDate === null ? 'unfinished uploads' : 'everything'),
    label: ruleDoes(r),
    days: r.expireAfterDays ?? (r.expireOnDate ? null : r.abortUploadsAfterDays),
    index: i,
    dim: !r.enabled,
  }));
  const whole = rules.some((r) => r.enabled && !r.prefix && r.expireAfterDays !== null && r.sizeGreaterThan === null && r.sizeLessThan === null);
  return whole ? rows : [...rows, { key: 'rest', where: rules.length ? 'everything else' : 'every file', label: 'kept until someone deletes it', days: null }];
}

/**
 * Board 42's age axis: upload → 7 d → 30 d → 1 y → forever, a bar per rule
 * ending where files go. At Controls each rule row gets its remove button.
 */
export function LifecycleTimeline({ rows, onRemove, busy }: { rows: TimelineRow[]; onRemove: (index: number) => void; busy: boolean }): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,10rem)_1fr] sm:gap-y-2.5">
      <span aria-hidden className="hidden sm:block" />
      <div aria-hidden className="flex gap-2">
        <div className="text-muted-foreground relative h-4 flex-1 font-mono text-[10.5px]">
          {AGE_MARKS.map((m) => (
            <span
              key={m.label}
              className={cn('absolute top-0 whitespace-nowrap', m.at === 0 ? '' : m.at === 100 ? '-translate-x-full' : '-translate-x-1/2')}
              style={{ left: `${m.at}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>
        {/* keeps the axis over the bars when the remove buttons show */}
        <Depth at="controls">
          <span className="w-8 shrink-0 pointer-coarse:w-11" />
        </Depth>
      </div>
      {rows.map((r) => (
        <React.Fragment key={r.key}>
          <span className={cn('mt-1.5 truncate font-mono text-[12.5px] font-semibold sm:mt-0', r.dim && 'text-muted-foreground')}>{r.where}</span>
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div role="img" aria-label={`${r.where}: ${r.label}`} className="bg-muted relative h-2 overflow-hidden rounded-full">
                <div
                  className={cn('h-full rounded-full', r.days === null ? 'bg-status-online/60' : 'bg-muted-foreground/60', r.dim && 'opacity-40')}
                  style={{ width: `${Math.max(agePosition(r.days), 2)}%` }}
                />
              </div>
              <span className="text-muted-foreground text-[11.5px]">{r.label}</span>
            </div>
            <Depth at="controls">
              {r.index !== undefined ? (
                <Button variant="ghost" size="icon" className="size-8 pointer-coarse:size-11" aria-label={`Remove the rule for ${r.where}`} disabled={busy} onClick={() => onRemove(r.index!)}>
                  <Trash2Icon className="size-4" />
                </Button>
              ) : (
                <span aria-hidden className="size-8 shrink-0 pointer-coarse:size-11" />
              )}
            </Depth>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
