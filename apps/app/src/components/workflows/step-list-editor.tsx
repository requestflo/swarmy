import * as React from 'react';
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { WORKFLOW_STEP_KINDS, type WorkflowStepKind } from '@swarmy/core';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from '@swarmy/ui';
import { STEP_KIND_LABEL } from './workflow-status';
import { StepFields } from './step-fields';
import { emptyStep, type StepDraft } from './step-draft';

/** Ordered step editor: add a step of any kind, reorder with up/down, edit inline. */
export function StepListEditor({
  steps,
  onChange,
}: {
  steps: StepDraft[];
  onChange: (next: StepDraft[]) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState<number | null>(steps.length === 0 ? null : 0);

  const add = (kind: WorkflowStepKind): void => {
    onChange([...steps, emptyStep(kind, steps.length)]);
    setOpen(steps.length);
  };
  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
    setOpen(j);
  };
  const remove = (i: number): void => {
    onChange(steps.filter((_, idx) => idx !== i));
    setOpen(null);
  };

  return (
    <div className="grid gap-2">
      {steps.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-center text-sm">
          No steps yet — add the first one below. Steps run top to bottom.
        </p>
      ) : null}

      {steps.map((step, i) => (
        <div key={i} className="rounded-xl border">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="mono-data bg-ink text-ink-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs">
              {i + 1}
            </span>
            <button
              type="button"
              onClick={() => setOpen(open === i ? null : i)}
              className="min-w-0 flex-1 text-left"
            >
              <span className="mono-data block truncate text-sm font-semibold">{step.name || '(unnamed)'}</span>
              <span className="text-muted-foreground text-xs">{STEP_KIND_LABEL[step.kind]}</span>
            </button>
            <Button variant="ghost" size="icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
              <ChevronUpIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={i === steps.length - 1}
              onClick={() => move(i, 1)}
              aria-label="Move down"
            >
              <ChevronDownIcon className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove step">
              <Trash2Icon className="text-status-offline size-4" />
            </Button>
          </div>
          <div className={cn('border-t px-3 py-3', open === i ? 'block' : 'hidden')}>
            <StepFields draft={step} onChange={(next) => onChange(steps.map((s, idx) => (idx === i ? next : s)))} />
          </div>
        </div>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="justify-center">
            <PlusIcon className="size-4" /> Add step
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {WORKFLOW_STEP_KINDS.map((kind) => (
            <DropdownMenuItem key={kind} onSelect={() => add(kind)}>
              {STEP_KIND_LABEL[kind]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
