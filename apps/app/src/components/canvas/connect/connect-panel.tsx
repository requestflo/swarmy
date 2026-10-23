import * as React from 'react';
import type { InvService } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { shortOf } from '@/components/connections/connections-model';
import type { StackEndpoints } from '@/components/connections/types';
import type { DataNodeSpec } from '../data-nodes';
import { reachWords } from './connect-plan';
import { ConnectPicker } from './connect-picker';
import { ConnectPreview, OtherAppLink } from './connect-preview';
import { useConnect } from './use-connect';

export interface ConnectState {
  from: string | null;
  to: string | null;
}

/**
 * Connect mode's card: the picker (keyboard, phones) and, once a part and a
 * target are chosen — by picking, clicking or dragging — the preview. Esc
 * backs out one step at a time.
 */
export function ConnectPanel({
  stack,
  parts,
  stores,
  buckets,
  endpoints,
  state,
  onChange,
  onExit,
  className,
}: {
  stack: string;
  parts: readonly InvService[];
  stores: DataNodeSpec[];
  buckets: DataNodeSpec[];
  endpoints: StackEndpoints | undefined;
  state: ConnectState;
  onChange: (s: ConnectState) => void;
  onExit: () => void;
  className?: string;
}): React.JSX.Element {
  const { connect, pending } = useConnect(stack);
  const part = (id: string | null) => parts.find((p) => p.id === id);
  const fromSvc = part(state.from);
  const from = fromSvc ? { id: fromSvc.id, name: fromSvc.name, short: shortOf(stack, fromSvc.name) } : null;
  const toStore = [...stores, ...buckets].find((s) => s.id === state.to);
  const toPart = part(state.to);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || pending) return;
      if (state.to) onChange({ ...state, to: null });
      else onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onChange, onExit, pending]);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="calm-card bg-card/95 px-3 py-2 backdrop-blur">
        <ConnectPicker
          parts={parts.map((p) => ({ id: p.id, short: shortOf(stack, p.name) }))}
          stores={stores}
          buckets={buckets}
          from={state.from}
          to={state.to}
          onFrom={(id) => onChange({ from: id, to: null })}
          onTo={(id) => onChange({ ...state, to: id })}
          onDone={onExit}
        />
        {!from ? <p className="text-muted-foreground pt-1 text-[12px]">Or drag from a part’s dot to the store it should use.</p> : null}
      </div>
      {from && toStore ? (
        <ConnectPreview
          stack={stack}
          from={from}
          to={toStore}
          stores={stores}
          pending={pending}
          onConnect={() => void connect(from, toStore).then((ok) => ok && onChange({ from: null, to: null }))}
          onCancel={() => onChange({ ...state, to: null })}
        />
      ) : null}
      {from && toPart ? (
        <div role="status" className="calm-card flex flex-col gap-2 px-4 py-3 text-[13px]">
          <p>{reachWords(from.short, shortOf(stack, toPart.name), endpoints)}</p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => onChange({ ...state, to: null })}>
              Close
            </Button>
            <OtherAppLink stack={stack} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
