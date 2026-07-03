import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkflowDefView } from '@swarmy/core';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StepListEditor } from './step-list-editor';
import { draftProblems, fromDraft, toDraft, type StepDraft } from './step-draft';

/**
 * Workflow builder, inline (a Collapsible parent supplies the expand/collapse
 * chrome). Creating makes version 1, scoped to `stack`; editing an existing
 * workflow saves a NEW version (history is kept).
 */
export function WorkflowBuilderInline({
  stack,
  editing,
  onDone,
}: {
  stack: string;
  editing: WorkflowDefView | null;
  onDone: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState(editing?.name ?? '');
  const [steps, setSteps] = React.useState<StepDraft[]>(() => (editing ? editing.steps.map(toDraft) : []));

  const done = (verb: string): void => {
    toast.success(`Workflow ${name} ${verb}`);
    void qc.invalidateQueries();
    onDone();
  };
  const create = useMutation(
    trpc.workflows.create.mutationOptions({
      onSuccess: () => done('created'),
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.workflows.update.mutationOptions({
      onSuccess: (d) => done(`saved as v${d.version}`),
      onError: (e) => toast.error(e.message),
    }),
  );

  const problems = draftProblems(steps);
  const nameOk = /^[a-z0-9][a-z0-9-]*$/.test(name);
  const pending = create.isPending || update.isPending;

  const submit = (): void => {
    const payload = { name, steps: steps.map(fromDraft) };
    if (editing) update.mutate(payload);
    else create.mutate({ ...payload, enabled: true, stackName: stack });
  };

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-xs">
        {editing
          ? `Saving creates version ${editing.version + 1} — v${editing.version} stays in history and in-flight runs finish on it.`
          : 'Steps run in order: containers, service execs, webhooks, approvals and delays.'}
      </p>
      <div className="grid gap-1.5">
        <Label className="mono-label">Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="document-pipeline"
          disabled={Boolean(editing)}
        />
        {!nameOk && name ? (
          <p className="text-status-offline text-xs">Lowercase letters, digits and dashes only.</p>
        ) : null}
      </div>
      <StepListEditor steps={steps} onChange={setSteps} />
      {problems.length > 0 && steps.length > 0 ? (
        <p className="text-status-warning text-xs">{problems[0]}</p>
      ) : null}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={!nameOk || problems.length > 0 || pending}>
          {pending ? 'Saving…' : editing ? `Save as v${editing.version + 1}` : 'Create workflow'}
        </Button>
      </div>
    </div>
  );
}
