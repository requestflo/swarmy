import * as React from 'react';
import { Button, cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import type { FleetView } from '../fleet/fleet-model';
import { copyWords } from './copy-words';
import { FitBar } from './fit-bar';
import { fitCheck } from './fit-check';
import { useMove, type MoveDraft } from './move-context';
import { memoryNow, type MovePlan } from './use-move-plan';
import { useAddCopy } from './use-add-copy';

/**
 * Board 9's ⌥-drag card: one more copy of a stateless service, started on
 * the server it was dropped on. The controller says whether Swarm would
 * start it there (`services.copyPlan`); the bar shows that one copy's memory.
 */
export function CopyPreview({ draft, toId, plan, servers }: { draft: MoveDraft; toId: string; plan: MovePlan; servers: FleetView[] }): React.JSX.Element {
  const m = useMove();
  const c = useAddCopy(draft, toId);
  const server = servers.find((s) => s.server.node.id === toId);
  const name = server?.server.node.name ?? toId;
  const perCopy = plan.needBytes === null ? null : plan.needBytes / Math.max(1, plan.copies);
  const fit = fitCheck({ needBytes: perCopy, dest: server ? memoryNow(server.server) : null });
  const w = copyWords({ short: draft.chip.short, target: name, answer: c.answer, failed: c.failed, fit });
  const desired = draft.chip.inv?.replicas.desired ?? plan.copies;
  return (
    <div className="flex flex-col gap-3">
      <span className={cn('inline-flex w-fit items-center gap-1.5 text-xs font-semibold', TONE_TEXT[w.tone])}>
        <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT[w.tone])} />
        {w.verdict}
      </span>
      <h3 className="font-display text-[18px] leading-tight font-bold tracking-[-0.01em]">{w.title}</h3>
      {w.body ? <p className="text-muted-foreground text-[13px] leading-relaxed">{w.body}</p> : null}
      {c.answer?.ok ? (
        <div className="bg-foreground/[0.04] rounded-xl px-3 py-2.5">
          <FitBar server={name} fit={fit} />
        </div>
      ) : null}
      <Tech>
        {`services.addCopy · ${draft.chip.name} → ${toId} · replicas ${desired} → ${desired + 1}`}
        {' · placement kept: Swarm starts it where it has the fewest copies, then the least busy server'}
      </Tech>
      {m.stage === 'confirm' ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={!w.go || c.pending} onClick={c.add} className="pointer-coarse:min-h-11">
            {c.pending ? 'Adding…' : 'Add a copy'}
          </Button>
          <Button variant="outline" onClick={m.cancel} className="pointer-coarse:min-h-11">
            Cancel
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground font-mono text-[12px]">Release to review · esc to cancel</p>
      )}
    </div>
  );
}
