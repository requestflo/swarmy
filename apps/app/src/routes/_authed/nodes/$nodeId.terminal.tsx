import * as React from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldAlertIcon, TerminalIcon } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { WebTerminal } from '@/components/terminal/web-terminal';

export const Route = createFileRoute('/_authed/nodes/$nodeId/terminal')({
  component: NodeTerminalPage,
});

type Phase = 'idle' | 'connecting' | 'open' | 'disabled' | 'closed' | 'error';

/**
 * Node shell — the host-RCE break-glass path. Far more gated than container
 * exec: ABAC `terminal.open` + org `TerminalPolicy.nodeShellEnabled` +
 * (by default) an approved `TerminalApproval`, and the agent's separate
 * `SWARMY_ALLOW_NODE_SHELL` flag. Recording is mandatory and non-disableable.
 */
function NodeTerminalPage(): React.JSX.Element {
  const trpc = useTRPC();
  const { nodeId } = useParams({ from: '/_authed/nodes/$nodeId/terminal' });

  const node = useQuery(trpc.nodes.get.queryOptions({ id: nodeId }));

  const [phase, setPhase] = React.useState<Phase>('idle');
  const [detail, setDetail] = React.useState<string | undefined>();
  const [wsUrl, setWsUrl] = React.useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = React.useState(false);

  const open = useMutation(
    trpc.terminal.openNodeShell.mutationOptions({
      onSuccess: ({ ticket }) => {
        const origin = window.location.origin.replace(/^http/, 'ws');
        setWsUrl(`${origin}/term/ws?ticket=${encodeURIComponent(ticket)}`);
        setPhase('connecting');
        setNeedsApproval(false);
      },
      onError: (e) => {
        const code = (e.data as { swarmyCode?: string } | undefined)?.swarmyCode;
        if (code === 'NEEDS_APPROVAL' || e.message.includes('approval')) {
          setNeedsApproval(true);
          setPhase('disabled');
          setDetail('Node-shell access requires approval.');
        } else {
          setPhase('error');
          setDetail(e.message);
        }
      },
    }),
  );

  const requestAccess = useMutation(
    trpc.terminal.approval.request.mutationOptions({
      onSuccess: () => setDetail('Access requested — an admin must approve before you can connect.'),
      onError: (e) => setDetail(e.message),
    }),
  );

  const start = (): void => {
    setPhase('connecting');
    setDetail(undefined);
    setWsUrl(null);
    open.mutate({ nodeId });
  };

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Node shell"
        title={
          <>
            Shell into <em>{node.data?.name ?? 'this node'}</em>.
          </>
        }
        description="A host shell on the node itself — the highest-risk access. Gated, approved, and recorded."
        actions={
          <Button onClick={start} disabled={open.isPending || phase === 'connecting'}>
            <TerminalIcon className="size-4" />
            {phase === 'open' || phase === 'connecting' ? 'Reconnect' : 'Open node shell'}
          </Button>
        }
      />

      <Alert className="card-pop mb-6 border-0">
        <ShieldAlertIcon className="size-4" />
        <AlertTitle>This session is recorded</AlertTitle>
        <AlertDescription>
          Node-shell sessions are recorded in full and audited. Recording cannot be disabled.
        </AlertDescription>
      </Alert>

      {phase === 'disabled' && (
        <Alert className="card-pop mb-6 border-0">
          <AlertTitle>Node shell unavailable</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>
              {detail ??
                'Node shell is disabled. Enable it in Security → Terminal and set SWARMY_ALLOW_NODE_SHELL=true on the agent.'}
            </span>
            {needsApproval && (
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={requestAccess.isPending}
                onClick={() => requestAccess.mutate({ nodeId, reason: 'break-glass node shell access' })}
              >
                Request access
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {phase === 'error' && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn’t open the node shell</AlertTitle>
          <AlertDescription>{detail ?? 'Unexpected error.'}</AlertDescription>
        </Alert>
      )}

      <Card className="card-pop border-0">
        <CardContent className="p-2">
          {wsUrl ? (
            <div style={{ height: '60vh', minHeight: 360 }}>
              <WebTerminal
                wsUrl={wsUrl}
                onPhase={(p, d) => {
                  setPhase(p);
                  if (d) setDetail(d);
                }}
              />
            </div>
          ) : (
            <div className="text-muted-foreground p-16 text-center text-sm">
              Press <span className="font-semibold">Open node shell</span> for break-glass host access.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
