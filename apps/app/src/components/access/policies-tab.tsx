import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, RotateCcwIcon, ScrollTextIcon } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, toast } from '@swarmy/ui';
import { CardSkeleton, ErrorState } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { PolicyRuleEditor } from './policy-rule-editor';
import { PolicyRuleRow } from './policy-rule-row';
import { PolicyWhoCan } from './policy-who-can';
import type { PolicyRow } from './use-policy-editor';

/**
 * Policies tab: the rules as plain sentences ("Members of platform can deploy
 * apps on apps where env is production."), a WHO × CAN × WHERE editor, and the
 * "who can…?" simulator. Enforcement is the server's authorize() — this only
 * edits and explains the rules.
 */
export function PoliciesTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policies = useQuery(trpc.policies.list.queryOptions());
  // undefined = closed, null = new rule, row = editing that rule.
  const [editing, setEditing] = React.useState<PolicyRow | null | undefined>(undefined);
  const reset = useMutation(
    trpc.policies.resetDefaults.mutationOptions({
      onSuccess: () => {
        toast.success('Default rules restored');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rows = (policies.data ?? []) as PolicyRow[];

  return (
    <div className="grid gap-6">
      <Card className="card-pop border-0">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">Rules</CardTitle>
            <CardDescription>
              Owners and admins can do everything. Members deploy and operate freely outside production;
              production, destructive actions, terminals and secrets need a rule below.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => reset.mutate()} disabled={reset.isPending}>
              <RotateCcwIcon className="size-4" /> Reset defaults
            </Button>
            <Button onClick={() => setEditing(null)}>
              <PlusIcon className="size-4" /> New rule
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {policies.isPending ? (
            <div className="px-6 pb-6">
              <CardSkeleton lines={4} />
            </div>
          ) : policies.error ? (
            <div className="px-6 pb-6">
              <ErrorState error={policies.error} retry={() => void policies.refetch()} />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                icon={<ScrollTextIcon />}
                title="No rules yet"
                description="The defaults are in force. Add a rule to let a group ship to production."
              />
            </div>
          ) : (
            <div className="divide-border divide-y border-t">
              {rows.map((p) => (
                <PolicyRuleRow key={p.id} rule={p} onEdit={setEditing} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <PolicyWhoCan />

      {editing !== undefined && <PolicyRuleEditor initial={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}
