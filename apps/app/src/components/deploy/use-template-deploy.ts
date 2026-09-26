import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BlueprintDeployResultView, BlueprintMetaView, BlueprintParamsInput } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Deploy a template with the Configure page's params: the same
 * `blueprints.deploy` call and the same hand-off as the inline panel
 * (components/blueprints/blueprint-deploy-panel.tsx) — a clean run goes
 * straight to the new app's page; a run with one-time reveals or a failure
 * stays here so nothing is lost.
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
        if (r.ok) toast.success(`${r.stackName} is deploying`);
        else toast.error(`Deploy of ${r.stackName} hit a snag — see the steps`);
        if (r.ok && r.notes.length === 0) {
          void navigate({ to: '/stacks/$name', params: { name: r.stackName } });
          return;
        }
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
