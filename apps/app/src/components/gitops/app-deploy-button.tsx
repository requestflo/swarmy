import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RocketIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { planStatus } from './plan-status';

interface AppDeployButtonProps {
  repoId: string;
  /** Environment branch to deploy; the production branch when omitted. */
  branch?: string;
  /** Open the plan the deploy produced. */
  onPlan: (planId: string) => void;
}

/** "Deploy now": plan + apply the branch head, then open that plan in the drawer. */
export function AppDeployButton({
  repoId,
  branch,
  onPlan,
}: AppDeployButtonProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const deploy = useMutation(
    trpc.apps.deploy.mutationOptions({
      onSuccess: (r) => {
        const words = planStatus(r.status).label;
        toast.success(r.reason ? `${words}: ${r.reason}` : `Deploying — ${words.toLowerCase()}.`);
        void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
        const id = r.plan?.id ?? r.planId;
        if (id) onPlan(id);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={deploy.isPending}
      onClick={() => deploy.mutate(branch ? { repoId, branch } : { repoId })}
    >
      <RocketIcon className="size-4" /> {deploy.isPending ? 'Deploying…' : 'Deploy now'}
    </Button>
  );
}
