import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import type { Inventory } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import type { FleetView } from '../fleet/fleet-model';
import { CopyPreview } from './copy-preview';
import { useMove } from './move-context';
import { MovePicker } from './move-picker';
import { MovePreview } from './move-preview';
import { MoveProgress } from './move-progress';
import { useMovePlan } from './use-move-plan';
import { useMoveProgress, useStartMove } from './use-move-run';

const CHECKS = ['Enough memory on the new server', 'Room on its disk for the data, with 20% to spare', 'Its data is copied before it switches', 'The copy is checked file by file', 'If anything fails, it goes back where it was'];

/**
 * Board 9 in the aside: while a service is dragged, picked or moving, the
 * card that says where it can go, asks once, and then follows the move.
 * With ⌥ held it offers one more copy on that server instead.
 * Renders nothing when there's nothing to say.
 */
export function MovePanel({ servers, inventory }: { servers: FleetView[]; inventory: Inventory | undefined }): React.JSX.Element | null {
  const m = useMove();
  const plan = useMovePlan(m.draft, servers, m.admin);
  const progress = useMoveProgress(inventory);
  const start = useStartMove();
  const nameOf = (id: string): string => servers.find((s) => s.server.node.id === id)?.server.node.name ?? id;

  let body: React.ReactNode = null;
  if (m.draft && plan) {
    const from = nameOf(m.draft.fromId);
    const target = plan.targets.find((t) => t.id === m.target) ?? null;
    if (m.stage === 'pick') {
      body = (
        <>
          <h3 className="font-display text-[18px] font-bold tracking-[-0.01em]">
            {plan.block ? `${m.draft.chip.short} stays where it is` : `Move ${m.draft.chip.short} to…`}
          </h3>
          <MovePicker plan={plan} />
          <Button size="sm" variant="ghost" className="w-fit pointer-coarse:min-h-11" onClick={m.cancel}>
            Cancel
          </Button>
        </>
      );
    } else if (target && m.copy) {
      body = <CopyPreview key={target.id} draft={m.draft} toId={target.id} plan={plan} servers={servers} />;
    } else if (target) {
      const draft = m.draft;
      body = (
        <MovePreview draft={draft} from={from} plan={plan} target={target}>
          {(go) =>
            m.stage === 'confirm' ? (
              <div className="flex flex-wrap gap-2">
                <Button disabled={!go || start.pending} onClick={() => start.start(draft, target.id)} className="pointer-coarse:min-h-11">
                  {start.pending ? 'Starting…' : `Move ${draft.chip.short}`}
                </Button>
                <Button variant="outline" onClick={m.cancel} className="pointer-coarse:min-h-11">
                  Cancel
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground font-mono text-[12px]">Release to review · esc to cancel</p>
            )
          }
        </MovePreview>
      );
    } else {
      body = (
        <>
          <h3 className="font-display text-[18px] font-bold tracking-[-0.01em]">Drop {m.draft.chip.short} on a server</h3>
          <p className="text-muted-foreground text-[13px]">Hold ⌥ as you drop to add a copy there instead. swarmy checks it fits before anything moves. Checked before every move:</p>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {CHECKS.map((c) => (
              <li key={c} className="flex items-center gap-2">
                <CheckIcon aria-hidden className="text-tone-ok size-3.5" />
                {c}
              </li>
            ))}
          </ul>
        </>
      );
    }
  }

  if (!body && !(m.run && progress)) return null;
  const chip = m.draft?.chip ?? m.run?.chip;
  return (
    <section aria-label="Move a service" className="calm-card border-primary/40 flex flex-col gap-3 px-5 py-4">
      <span className="calm-eyebrow">{chip ? `${chip.app ? `${chip.app} / ` : ''}${chip.short}` : 'Move'}</span>
      {body ? <div className="flex flex-col gap-3">{body}</div> : null}
      {m.run && progress ? (
        <div className={body ? 'border-border border-t pt-3' : undefined}>
          <MoveProgress run={m.run} phase={progress.phase} step={progress.step} from={nameOf(m.run.fromId)} to={nameOf(m.run.toId)} onDismiss={m.dismiss} />
        </div>
      ) : null}
    </section>
  );
}
