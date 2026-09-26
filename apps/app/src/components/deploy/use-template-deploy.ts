import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BlueprintDeployResultView, BlueprintMetaView, BlueprintParamsInput } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { landOnDeployedApp } from './deploy-handoff';

/**
 * Deploy a template with the Configure page's params (`blueprints.deploy`).
 * Once the app itself went out it lands on the app page's "Deploying → It's
 * live" state, result and one-time reveals carried over in memory
 * (`landOnDeployedApp`). Only a run that stopped before the app existed stays
 * here and shows its steps.
 */
export function useTemplateDeploy(meta: BlueprintMetaView) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [result, setResult] = React.useState<BlueprintDeployResultView | null>(null);
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
  const run = (params: BlueprintParamsInput): void => {
    if (!deploy.isPending) deploy.mutate({ id: meta.id, params });
  };
  return { run, pending: deploy.isPending, result, clear: () => setResult(null) };
}
