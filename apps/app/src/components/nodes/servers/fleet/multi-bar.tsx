import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { Button, Input } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { names, useBulkActions } from './use-bulk-actions';

type Mode = 'idle' | 'drain' | 'label';

/**
 * Board 11's selection bar: how many are picked, then Drain · Add label ·
 * Upgrade agents across them. Draining asks once; a label is one key=value.
 */
export function MultiBar({ picked, admin, onDone }: { picked: NodeSummary[]; admin: boolean; onDone: () => void }): React.JSX.Element {
  const bulk = useBulkActions();
  const [mode, setMode] = React.useState<Mode>('idle');
  const [text, setText] = React.useState('');
  const none = picked.length === 0;
  const stale = picked.filter((n) => n.agentUpdateAvailable && n.status !== 'offline');
  const eq = text.indexOf('=');
  const [key, value] = eq > 0 ? [text.slice(0, eq).trim(), text.slice(eq + 1).trim()] : ['', ''];
  const btn = 'pointer-coarse:min-h-11';

  return (
    <div role="toolbar" aria-label="Selected servers" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[13.5px] font-semibold">{picked.length} selected</span>
      <span className="text-muted-foreground min-w-0 truncate font-mono text-[12px]">{none ? 'click servers to pick them' : names(picked)}</span>
      <span aria-hidden className="bg-border hidden h-5 w-px sm:block" />
      {mode === 'drain' ? (
        <>
          <span className="text-[13px]">Their apps move to your other servers and nothing new lands there.</span>
          <Button size="sm" variant="outline" className={btn} disabled={bulk.busy} onClick={() => void bulk.drain(picked).then(() => setMode('idle'))}>
            Drain {picked.length}
          </Button>
          <Button size="sm" variant="ghost" className={btn} onClick={() => setMode('idle')}>
            Cancel
          </Button>
        </>
      ) : mode === 'label' ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key) void bulk.label(picked, key, value).then(() => setMode('idle'));
          }}
        >
          <Input autoFocus aria-label="Label as key=value" placeholder="team=platform" value={text} onChange={(e) => setText(e.target.value)} className="h-8 w-44 font-mono text-[12.5px]" />
          <Button size="sm" variant="outline" type="submit" className={btn} disabled={!key || bulk.busy}>
            Add to {picked.length}
          </Button>
          <Button size="sm" variant="ghost" type="button" className={btn} onClick={() => setMode('idle')}>
            Cancel
          </Button>
          <Tech>nodes.setLabels · merged into each server’s Docker node labels</Tech>
        </form>
      ) : (
        <>
          <Button size="sm" variant="outline" className={btn} disabled={none} onClick={() => setMode('drain')}>
            Drain
          </Button>
          <Button size="sm" variant="outline" className={btn} disabled={none} onClick={() => setMode('label')}>
            Add label
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={btn}
            disabled={!admin || stale.length === 0 || bulk.busy}
            title={!admin ? 'Only admins and owners can upgrade agents.' : stale.length === 0 ? 'Every picked server runs the latest agent.' : undefined}
            onClick={() => void bulk.upgrade(stale)}
          >
            Upgrade agents{stale.length ? ` (${stale.length})` : ''}
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" className={btn} onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
