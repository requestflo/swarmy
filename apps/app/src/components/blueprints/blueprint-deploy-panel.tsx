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
import { landOnDeployedApp } from '@/components/deploy/deploy-handoff';
import { BlueprintDeployResult } from './blueprint-deploy-result';

/**
 * The inline deploy wizard that expands inside a gallery card (no modal):
 * params form → dry-run plan preview → sequential deploy. Once the app itself
 * went out, it always lands on the app page's "Deploying → It's live" state,
 * carrying the step results and any one-time reveals (in memory, never the
 * URL). Only a run that stopped before the app existed stays inline.
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
        if (landOnDeployedApp(r, navigate)) return;
        toast.error(`Deploy of ${r.stackName} hit a snag — see the steps`);
        setResult(r);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const phase = result ? 'result' : params ? 'preview' : 'form';

  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-muted-foreground text-xs">
        {phase === 'form'
          ? 'Nothing runs until you press Deploy.'
          : phase === 'preview'
            ? 'This is exactly what gets created. Nothing has run yet.'
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
