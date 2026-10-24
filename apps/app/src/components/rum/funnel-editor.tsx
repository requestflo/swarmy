import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import { Button, Input } from '@swarmy/ui';
import { RumSection, Segmented } from './rum-ui';
import { FunnelStepRow } from './funnel-step-row';
import { draftProblem, MAX_STEPS, moveStep, WINDOW_CHOICES, type Funnel, type FunnelDraft } from './funnel-model';
import { useSaveFunnels } from './use-funnels';

interface FunnelEditorProps {
  stack: string;
  /** Every saved funnel (the save replaces the whole list). */
  funnels: Funnel[];
  /** The funnel being edited: a saved one, or a new starter. Remount (key) to switch. */
  initial: FunnelDraft;
  isNew: boolean;
  admin: boolean;
  onSaved: (id: string | null) => void;
  onCancel?: () => void;
}

/**
 * Controls depth: the funnel's steps, in order — a page path pattern each,
 * optionally a custom event fired there. Saving writes the
 * `swarmy.rum.funnels` label on the app's services; nothing redeploys.
 */
export function FunnelEditor({ stack, funnels, initial, isNew, admin, onSaved, onCancel }: FunnelEditorProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<FunnelDraft>(initial);
  const { save, pending } = useSaveFunnels(stack);
  const problem = draftProblem(draft);
  const off = !admin || pending;
  const dirty = isNew || JSON.stringify(draft) !== JSON.stringify(initial);
  const steps = draft.steps;
  const setSteps = (next: FunnelDraft['steps']): void => setDraft({ ...draft, steps: next });
  const others = funnels.filter((f) => f.id !== draft.id);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (problem || off || !dirty) return;
    const clean = { ...draft, name: draft.name.trim(), steps: steps.map((s) => ({ ...s, path: s.path.trim() })) };
    const list = isNew ? [...funnels, clean] : funnels.map((f) => (f.id === draft.id ? clean : f));
    save(list, () => onSaved(draft.id));
  };

  return (
    <RumSection title={isNew ? 'New funnel' : `Edit ${initial.name}`} badge={<span className="text-muted-foreground font-mono text-[11px]">swarmy.rum.funnels</span>}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={60}
            disabled={off}
            aria-label="Funnel name"
            className="h-8 max-w-xs text-sm font-semibold"
          />
          <span className="text-muted-foreground text-xs">counts a visit that gets from the first step to the last within</span>
          <Segmented
            label="Conversion window"
            value={draft.windowMinutes ?? 60}
            options={WINDOW_CHOICES}
            disabled={off}
            onChange={(windowMinutes) => setDraft({ ...draft, windowMinutes })}
          />
        </div>
        <ol className="flex flex-col gap-2">
          {steps.map((s, i) => (
            <FunnelStepRow
              key={i}
              step={s}
              index={i}
              count={steps.length}
              disabled={off}
              onChange={(next) => setSteps(steps.map((x, k) => (k === i ? next : x)))}
              onMove={(dir) => setSteps(moveStep(steps, i, dir))}
              onRemove={() => setSteps(steps.filter((_, k) => k !== i))}
            />
          ))}
        </ol>
        <p className="text-muted-foreground text-xs">
          <code className="font-mono">*</code> matches any part of a path. An event step also needs the page to call{' '}
          <code className="font-mono">window.__swarmy.track('paid')</code>.
        </p>
        {problem && admin ? <p className="text-tone-warn text-xs">{problem}</p> : null}
        {!admin ? <p className="text-muted-foreground text-xs">Owners and admins can change funnels.</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" className="rounded-full" disabled={off || !!problem || !dirty}>
            {pending ? 'Saving…' : 'Save funnel'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="rounded-full"
            disabled={off || steps.length >= MAX_STEPS}
            onClick={() => setSteps([...steps, { path: '/' }])}
          >
            <PlusIcon className="size-3.5" /> Add a step
          </Button>
          {isNew && onCancel ? (
            <Button type="button" size="sm" variant="ghost" className="rounded-full" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {!isNew ? (
            <Button type="button" size="sm" variant="ghost" className="text-tone-bad ml-auto rounded-full" disabled={off} onClick={() => save(others, () => onSaved(others[0]?.id ?? null))}>
              Remove funnel
            </Button>
          ) : null}
        </div>
      </form>
    </RumSection>
  );
}
