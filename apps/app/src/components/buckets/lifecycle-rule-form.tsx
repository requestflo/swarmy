import * as React from 'react';
import { MAX_LIFECYCLE_DAYS, type LifecycleRuleInput } from '@swarmy/core';
import { Button, Input, Label } from '@swarmy/ui';
import { fmtDays, ruleWhere } from './lifecycle-model';

const days = (s: string): number | null | 'bad' => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LIFECYCLE_DAYS ? n : 'bad';
};

/** Controls: a new rule — which files (a prefix, or all), delete after N days, clear unfinished uploads after N days. */
export function LifecycleRuleForm({ pending, onAdd }: { pending: boolean; onAdd: (rule: LifecycleRuleInput) => void }): React.JSX.Element {
  const [prefix, setPrefix] = React.useState('');
  const [expire, setExpire] = React.useState('');
  const [abort, setAbort] = React.useState('');
  const e = days(expire);
  const a = days(abort);
  const valid = e !== 'bad' && a !== 'bad' && (e !== null || a !== null);
  const where = ruleWhere({ prefix: prefix.trim() });

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label className="mono-label">Files under (blank = all)</Label>
          <Input value={prefix} onChange={(x) => setPrefix(x.target.value)} placeholder="tmp/" className="mono-data" autoComplete="off" spellCheck={false} />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Delete after (days)</Label>
          <Input value={expire} onChange={(x) => setExpire(x.target.value)} placeholder="30" inputMode="numeric" className="mono-data" aria-invalid={e === 'bad' || undefined} />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Clear unfinished uploads after</Label>
          <Input value={abort} onChange={(x) => setAbort(x.target.value)} placeholder="7" inputMode="numeric" className="mono-data" aria-invalid={a === 'bad' || undefined} />
        </div>
        <Button
          variant="outline"
          disabled={pending || !valid}
          onClick={() => {
            onAdd({ prefix: prefix.trim(), expireAfterDays: e === 'bad' ? null : e, abortUploadsAfterDays: a === 'bad' ? null : a });
            setPrefix('');
            setExpire('');
            setAbort('');
          }}
        >
          Add rule
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {valid && typeof e === 'number'
          ? `${where.charAt(0).toUpperCase()}${where.slice(1)} older than ${fmtDays(e)} will be deleted for good, from the next daily run.`
          : 'Days are whole numbers from 1. Garage applies the rules once a day; it can’t move files to cheaper storage.'}
      </p>
    </div>
  );
}
