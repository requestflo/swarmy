import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Pending node-shell requests. With "require approval for node shells" on, a
 * member asks from the node's terminal page; another admin approves or denies
 * here. The server refuses a decision on your own request (four-eyes).
 */
export function TerminalApprovalsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const approvals = useQuery({ ...trpc.terminal.approval.list.queryOptions(), refetchInterval: 15_000 });
  const members = useQuery(trpc.security.members.queryOptions());
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const me = useQuery(trpc.org.whoami.queryOptions());
  const decide = useMutation(
    trpc.terminal.approval.decide.mutationOptions({
      onSuccess: (row) => {
        toast.success(row.status === 'approved' ? 'Node shell approved' : 'Request denied');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const who = (userId: string): string => {
    const m = members.data?.find((x) => x.userId === userId);
    return m ? m.name || m.email || userId : userId;
  };
  const nodeName = (nodeId: string): string =>
    nodes.data?.find((n) => n.id === nodeId)?.hostname ?? nodeId;
  const myUserId = me.data?.userId;

  const pending = (approvals.data ?? []).filter(
    (a) => a.status === 'pending' && new Date(a.expiresAt).getTime() > Date.now(),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Node shell requests</CardTitle>
      </CardHeader>
      <CardContent>
        {!approvals.data ? (
          <Skeleton className="h-16 w-full" />
        ) : pending.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing waiting. Requests show up here when someone asks for a node shell.</p>
        ) : (
          <ul className="divide-border divide-y">
            {pending.map((a) => {
              const mine = myUserId != null && a.requestedById === myUserId;
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {who(a.requestedById)} · {nodeName(a.nodeId)}
                    </div>
                    <div className="text-muted-foreground truncate text-xs">
                      {a.reason} · expires {new Date(a.expiresAt).toLocaleTimeString()}
                    </div>
                  </div>
                  {mine ? (
                    <span className="text-muted-foreground text-xs">Your request: another admin decides</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ approvalId: a.id, approve: false })}
                      >
                        Deny
                      </Button>
                      <Button
                        size="sm"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ approvalId: a.id, approve: true })}
                      >
                        Approve
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
