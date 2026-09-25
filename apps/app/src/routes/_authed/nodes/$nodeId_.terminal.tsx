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
import { CalmTopBar, SayHeader } from '@/components/calm';
import { WebTerminal } from '@/components/terminal/web-terminal';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { useStepUp } from '@/components/security/use-step-up';

export const Route = createFileRoute('/_authed/nodes/$nodeId_/terminal')({
  component: NodeTerminalPage,
});

type Phase = 'idle' | 'connecting' | 'open' | 'disabled' | 'closed' | 'error';

/**
 * Node shell — the host-RCE break-glass path. Far more gated than container
 * exec: ABAC `terminal.open` + org `TerminalPolicy.nodeShellEnabled` +
 * (by default) an approved `TerminalApproval`, plus the node's admin-only
 * 'Host shell' toggle (`swarmy.node.shell=true`, off by default) and no local
 * `SWARMY_ALLOW_NODE_SHELL=false` veto. Recording is mandatory and non-disableable.
 */
function NodeTerminalPage(): React.JSX.Element {
  const trpc = useTRPC();
  const { nodeId } = useParams({ from: '/_authed/nodes/$nodeId_/terminal' });

  const node = useQuery(trpc.nodes.get.queryOptions({ id: nodeId }));

  const [phase, setPhase] = React.useState<Phase>('idle');
  const [detail, setDetail] = React.useState<string | undefined>();
  const [wsUrl, setWsUrl] = React.useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = React.useState(false);

  // Step-up (requireMfa): a stale/missing second factor opens the code dialog,
  // then the open is retried.
  const startRef = React.useRef<() => void>(() => undefined);
  const stepUp = useStepUp(() => startRef.current());

  const open = useMutation(
    trpc.terminal.openNodeShell.mutationOptions({
      onSuccess: ({ ticket }) => {
        const origin = window.location.origin.replace(/^http/, 'ws');
        setWsUrl(`${origin}/term/ws?ticket=${encodeURIComponent(ticket)}`);
        setPhase('connecting');
        setNeedsApproval(false);
      },
      onError: (e) => {
        if (stepUp.intercept(e)) {
          setPhase('idle');
          return;
        }
        const code = (e.data as { swarmyCode?: string } | undefined)?.swarmyCode;
        if (code === 'NEEDS_APPROVAL' || e.message.includes('approval')) {
          setNeedsApproval(true);
          setPhase('disabled');
          setDetail('Node-shell access requires approval.');
        } else if (
          code === 'NODE_SHELL_DISABLED' ||
          code === 'NODE_SHELL_OFF_ON_NODE' ||
          code === 'NODE_SHELL_BLOCKED_LOCALLY'
        ) {
          setNeedsApproval(false);
          setPhase('disabled');
          setDetail(e.message);
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
  startRef.current = start;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col px-6 pt-8 lg:pb-20 xl:px-10">
      <div className="-mx-6 -mt-8 mb-7 xl:-mx-10">
        <CalmTopBar
          crumbs={[
            { label: 'Servers', to: '/nodes' },
            { label: node.data?.name ?? 'Server', to: '/nodes/$nodeId', params: { nodeId } },
            { label: 'Shell' },
          ]}
        />
        <div className="px-6 pt-7 xl:px-10">
          <SayHeader
            title={<>A shell on {node.data?.name ?? 'this server'}.</>}
            lede="Root on the server itself, for when nothing else will do. Approved, recorded and audited."
            actions={
              <Button onClick={start} disabled={open.isPending || phase === 'connecting'} className="pointer-coarse:min-h-11">
                <TerminalIcon className="size-4" />
                {phase === 'open' || phase === 'connecting' ? 'Reconnect' : 'Open the shell'}
              </Button>
            }
          />
        </div>
      </div>

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
              {detail && !detail.startsWith('E_')
                ? detail
                : 'Host shell is off for this server. An admin turns it on in Servers → this server → Controls → Host shell (and node shell must be enabled in Security → Terminal).'}
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
              Press <span className="font-semibold">Open the shell</span> for break-glass access to the server.
            </div>
          )}
        </CardContent>
      </Card>
      <StepUpDialog {...stepUp.dialog} />
    </div>
  );
}
