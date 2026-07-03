import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BlueprintDeployResultView,
  BlueprintMetaView,
  BlueprintParamsInput,
} from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { BlueprintParamsForm } from './blueprint-params-form';
import { BlueprintPlanPreview } from './blueprint-plan-preview';
import { BlueprintDeployResult } from './blueprint-deploy-result';

/**
 * The inline deploy wizard that expands inside a gallery card (no modal):
 * params form → dry-run plan preview → sequential deploy. A clean success
 * navigates straight to the new stack's workspace; results carrying one-time
 * reveals stay inline (coral banner) so nothing is lost.
 */
export function BlueprintDeployPanel({
  meta,
  onClose,
}: {
  meta: BlueprintMetaView;
  onClose: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = React.useState<BlueprintParamsInput | null>(null);
  const [result, setResult] = React.useState<BlueprintDeployResultView | null>(null);

  const plan = useQuery({
    ...trpc.blueprints.plan.queryOptions({
      id: meta.id,
      params: params ?? { name: 'x', size: 'm', options: {} },
    }),
    enabled: params !== null && !result,
  });

  const deploy = useMutation(
    trpc.blueprints.deploy.mutationOptions({
      onSuccess: (r) => {
        void qc.invalidateQueries();
        if (r.ok) toast.success(`Stack ${r.stackName} is deploying`);
        else toast.error(`Deploy of ${r.stackName} hit a snag — see the steps`);
        // Nothing to reveal → straight into the new stack's workspace.
        if (r.ok && r.notes.length === 0) {
          void navigate({ to: '/stacks/$name', params: { name: r.stackName } });
          return;
        }
        setResult(r);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const phase = result ? 'result' : params ? 'preview' : 'form';

  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-xs">
        {phase === 'form'
          ? 'Name it, size it — nothing is created until you deploy.'
          : phase === 'preview'
            ? 'Review the plan — nothing has been created yet.'
            : result?.ok
              ? 'Everything below ran in order. Give services a minute to converge.'
              : 'The first failure stopped the run; later steps were skipped.'}
      </p>
      {phase === 'form' ? (
        <BlueprintParamsForm meta={meta} onSubmit={setParams} />
      ) : phase === 'preview' && params ? (
        <BlueprintPlanPreview
          plan={plan.data}
          loading={plan.isLoading}
          error={plan.isError ? plan.error.message : null}
          onBack={() => setParams(null)}
          deploying={deploy.isPending}
          onDeploy={() => deploy.mutate({ id: meta.id, params })}
        />
      ) : result ? (
        <BlueprintDeployResult result={result} onClose={onClose} />
      ) : null}
    </div>
  );
}
