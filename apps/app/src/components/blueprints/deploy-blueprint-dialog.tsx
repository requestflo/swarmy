import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BlueprintDeployResultView,
  BlueprintMetaView,
  BlueprintParamsInput,
} from '@swarmy/core';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { BlueprintParamsForm } from './blueprint-params-form';
import { BlueprintPlanPreview } from './blueprint-plan-preview';
import { BlueprintDeployResult } from './blueprint-deploy-result';

/**
 * The deploy wizard: params form → dry-run plan preview → sequential deploy
 * with per-step results. Deploy results include one-time reveals, so the
 * dialog only resets when it closes.
 */
export function DeployBlueprintDialog({
  meta,
  onOpenChange,
}: {
  meta: BlueprintMetaView | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [params, setParams] = React.useState<BlueprintParamsInput | null>(null);
  const [result, setResult] = React.useState<BlueprintDeployResultView | null>(null);

  const plan = useQuery({
    ...trpc.blueprints.plan.queryOptions({
      id: meta?.id ?? 'node-api',
      params: params ?? { name: 'x', size: 'm', options: {} },
    }),
    enabled: Boolean(meta && params) && !result,
  });

  const deploy = useMutation(
    trpc.blueprints.deploy.mutationOptions({
      onSuccess: (r) => {
        setResult(r);
        if (r.ok) toast.success(`Stack ${r.stackName} is deploying`);
        else toast.error(`Deploy of ${r.stackName} hit a snag — see the steps`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (open: boolean): void => {
    onOpenChange(open);
    if (!open) {
      setParams(null);
      setResult(null);
      deploy.reset();
    }
  };

  const phase = result ? 'result' : params ? 'preview' : 'form';

  return (
    <Dialog open={meta !== null} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {meta ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {phase === 'result'
                  ? result?.ok
                    ? "It's deploying."
                    : 'Deploy stopped.'
                  : `Deploy ${meta.name}`}
              </DialogTitle>
              <DialogDescription>
                {phase === 'form'
                  ? meta.tagline
                  : phase === 'preview'
                    ? 'Review the plan — nothing has been created yet.'
                    : result?.ok
                      ? 'Everything below ran in order. Give services a minute to converge.'
                      : 'The first failure stopped the run; later steps were skipped.'}
              </DialogDescription>
            </DialogHeader>
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
              <BlueprintDeployResult result={result} onClose={() => close(false)} />
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
