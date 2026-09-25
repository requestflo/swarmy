import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { PolicyRuleEditor } from './policy-rule-editor';
import { PolicyRuleRow } from './policy-rule-row';
import type { PolicyRow } from './use-policy-editor';

/**
 * The rules, read as sentences ("Members of platform can deploy apps where env
 * is production."). From Controls: switch, edit, delete and write a rule.
 * Enforcement is the server's authorize(); this only edits and explains.
 */
export function PoliciesTab(): React.JSX.Element {
  const trpc = useTRPC();
  const policies = useQuery(trpc.policies.list.queryOptions());
  // undefined = closed, null = new rule, row = editing that rule.
  const [editing, setEditing] = React.useState<PolicyRow | null | undefined>(undefined);
  const rows = (policies.data ?? []) as PolicyRow[];
  if (policies.isPending) return <CardSkeleton lines={4} />;
  if (policies.error) return <ErrorState title="Couldn’t load the rules." error={policies.error} retry={() => void policies.refetch()} />;
  return (
    <>
      <Section
        id="rules"
        title="Rules decide who can do what"
        count={`${rows.filter((r) => r.enabled).length} on`}
        flush
        action={
          <Depth at="controls">
            <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setEditing(null)}>
              <PlusIcon className="size-4" /> Write a rule
            </Button>
          </Depth>
        }
      >
        <p className="text-muted-foreground pb-2 text-[13px]">
          Owners and admins can do everything. Members deploy and run apps outside production; production, deleting things, terminals and secrets need a rule. A “never” rule beats any “can”.
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">The defaults are in force. Add a rule to let a group ship to production.</p>
        ) : (
          rows.map((p) => <PolicyRuleRow key={p.id} rule={p} onEdit={setEditing} />)
        )}
      </Section>
      {editing !== undefined && <PolicyRuleEditor initial={editing} onClose={() => setEditing(undefined)} />}
    </>
  );
}
