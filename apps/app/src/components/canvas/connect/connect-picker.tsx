import * as React from 'react';
import { Button } from '@swarmy/ui';
import type { DataNodeSpec } from '../data-nodes';
import { storeWords } from './connect-plan';

export interface PickerPart {
  id: string;
  short: string;
}

const SELECT =
  'border-border bg-background h-8 w-full min-w-0 rounded-[8px] border px-2 font-mono text-[12px] pointer-coarse:min-h-11';

/**
 * The keyboard way to connect (and the only way on a phone): pick the part,
 * then what it should use — another part, one of the app's stores, or a
 * bucket it doesn't use yet. Dragging on the canvas fills the same two fields.
 */
export function ConnectPicker({
  parts,
  stores,
  buckets,
  from,
  to,
  onFrom,
  onTo,
  onDone,
}: {
  parts: PickerPart[];
  stores: DataNodeSpec[];
  /** Buckets this app doesn't use yet. */
  buckets: DataNodeSpec[];
  from: string | null;
  to: string | null;
  onFrom: (id: string | null) => void;
  onTo: (id: string | null) => void;
  onDone: () => void;
}): React.JSX.Element {
  const fromId = React.useId();
  const toId = React.useId();
  const fromRef = React.useRef<HTMLSelectElement>(null);
  React.useEffect(() => fromRef.current?.focus({ preventScroll: true }), []);
  const others = parts.filter((p) => p.id !== from);

  return (
    <div role="group" aria-label="Connect a part" className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 text-[12.5px]">
      <label htmlFor={fromId} className="text-muted-foreground">
        Connect
      </label>
      <select id={fromId} ref={fromRef} className={SELECT} value={from ?? ''} onChange={(e) => onFrom(e.target.value || null)}>
        <option value="">pick a part…</option>
        {parts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.short}
          </option>
        ))}
      </select>
      <span />
      <label htmlFor={toId} className="text-muted-foreground justify-self-end">
        to
      </label>
      <select id={toId} className={SELECT} value={to ?? ''} disabled={!from} onChange={(e) => onTo(e.target.value || null)}>
        <option value="">{from ? 'what it should use…' : 'pick a part first'}</option>
        {stores.length ? (
          <optgroup label="This app’s data">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {storeWords(s)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {buckets.length ? (
          <optgroup label="Other buckets">
            {buckets.map((s) => (
              <option key={s.id} value={s.id}>
                {storeWords(s)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {others.length ? (
          <optgroup label="Parts of this app">
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.short}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      <Button size="sm" variant="ghost" className="text-muted-foreground h-8 pointer-coarse:min-h-11" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
