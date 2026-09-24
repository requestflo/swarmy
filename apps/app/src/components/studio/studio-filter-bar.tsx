import * as React from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { FILTER_OPS } from '@swarmy/core/studio';
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@swarmy/ui';
import type { StudioFilter } from './studio-types';

interface StudioFilterBarProps {
  columns: string[];
  filters: StudioFilter[];
  onChange: (f: StudioFilter[]) => void;
  sortLine: string;
}

/** Filter chips (`status = paid ×`) + an inline "add filter" row. Built into a quoted WHERE server-side. */
export function StudioFilterBar({ columns, filters, onChange, sortLine }: StudioFilterBarProps): React.JSX.Element {
  const [adding, setAdding] = React.useState(false);
  const [col, setCol] = React.useState('');
  const [op, setOp] = React.useState<StudioFilter['op']>('=');
  const [val, setVal] = React.useState('');
  const needsValue = op !== 'is null' && op !== 'is not null';
  const add = () => {
    if (!col) return;
    onChange([...filters, { column: col, op, ...(needsValue ? { value: val } : {}) }]);
    setAdding(false);
    setVal('');
  };
  return (
    <div className="border-border bg-card flex flex-wrap items-center gap-2 border-b px-3 py-2">
      {filters.map((f, i) => (
        <button
          key={`${f.column}${i}`}
          type="button"
          onClick={() => onChange(filters.filter((_, j) => j !== i))}
          className="border-status-progress/50 bg-status-progress/10 text-status-progress inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-xs"
        >
          {f.column} {f.op} {needsValueOf(f) ? JSON.stringify(f.value ?? '') : ''}
          <XIcon className="size-3" />
        </button>
      ))}
      {adding ? (
        <form className="flex flex-wrap items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Select value={col} onValueChange={setCol}>
            <SelectTrigger className="h-7 w-40 text-xs"><SelectValue placeholder="column" /></SelectTrigger>
            <SelectContent>{columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={op} onValueChange={(v) => setOp(v as StudioFilter['op'])}>
            <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{FILTER_OPS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
          </Select>
          {needsValue ? <Input value={val} onChange={(e) => setVal(e.target.value)} className="h-7 w-40 font-mono text-xs" placeholder="value" /> : null}
          <Button size="sm" type="submit" variant="outline" className="h-7">Add</Button>
          <Button size="sm" type="button" variant="ghost" className="h-7" onClick={() => setAdding(false)}>Cancel</Button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="border-border text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 rounded-full border px-2.5 font-mono text-xs">
          <PlusIcon className="size-3" /> filter
        </button>
      )}
      <div className="flex-1" />
      <span className="text-muted-foreground font-mono text-[11px]">{sortLine}</span>
    </div>
  );
}

function needsValueOf(f: StudioFilter): boolean {
  return f.op !== 'is null' && f.op !== 'is not null';
}

/** Mongo: a filter document instead of chips. */
export function StudioMongoFilter({ value, onApply, sortLine }: { value: string; onApply: (v: string) => void; sortLine: string }): React.JSX.Element {
  const [draft, setDraft] = React.useState(value);
  return (
    <form className="border-border bg-card flex items-center gap-2 border-b px-3 py-2" onSubmit={(e) => { e.preventDefault(); onApply(draft); }}>
      <span className="mono-label text-muted-foreground">filter</span>
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder='{ status: "paid" }' className="h-7 flex-1 font-mono text-xs" />
      <Button size="sm" type="submit" variant="outline" className="h-7">Apply</Button>
      <span className="text-muted-foreground hidden font-mono text-[11px] sm:inline">{sortLine}</span>
    </form>
  );
}
