import * as React from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { TerminalIcon } from 'lucide-react';
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
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { useStepUp } from '@/components/security/use-step-up';

export const Route = createFileRoute('/_authed/services/$serviceId_/terminal')({
  component: ServiceTerminalPage,
});

type Phase = 'idle' | 'connecting' | 'open' | 'disabled' | 'closed' | 'error';

function ServiceTerminalPage(): React.JSX.Element {
  const trpc = useTRPC();
  const { serviceId } = useParams({ from: '/_authed/services/$serviceId_/terminal' });

  // The service detail tells us which node + container to exec into. The MVP
  // execs into the first running container of the service on its node.
  const svc = useQuery(trpc.services.get.queryOptions({ id: serviceId }));

  const [phase, setPhase] = React.useState<Phase>('idle');
  const [detail, setDetail] = React.useState<string | undefined>();
  const [wsUrl, setWsUrl] = React.useState<string | null>(null);

  const onPhase = React.useCallback((p: Phase, d?: string): void => {
    setPhase(p);
    if (d) setDetail(d);
  }, []);

  // `terminal.open` mutation (control plane). It runs the policy gate (ABAC,
  // org TerminalPolicy, the node's 'Container exec' toggle + any local
  // SWARMY_ALLOW_EXEC=false veto, container exists), audits, mints a
  // single-use ticket, and returns { ticket, wsUrl }.
  // Step-up (requireMfa): a stale/missing second factor opens the code dialog,
  // then the open is retried.
  const startRef = React.useRef<() => void>(() => undefined);
  const stepUp = useStepUp(() => startRef.current());

  const open = useMutation(
    trpc.terminal.open.mutationOptions({
      onSuccess: ({ ticket, wsUrl: base }: { ticket: string; wsUrl?: string }) => {
        const origin = window.location.origin.replace(/^http/, 'ws');
        const url = `${base ?? `${origin}/term/ws`}?ticket=${encodeURIComponent(ticket)}`;
        setWsUrl(url);
        setPhase('connecting');
      },
      onError: (e) => {
        if (stepUp.intercept(e)) {
          setPhase('idle');
          return;
        }
        const code = (e.data as { swarmyCode?: string } | undefined)?.swarmyCode;
        setPhase(code === 'EXEC_DISABLED_ON_NODE' || code === 'EXEC_BLOCKED_LOCALLY' ? 'disabled' : 'error');
        setDetail(e.message);
      },
    }),
  );

  const start = (): void => {
    setPhase('connecting');
    setDetail(undefined);
    setWsUrl(null);
    open.mutate({ serviceId });
  };
  startRef.current = start;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Terminal"
        title={
          <>
            Shell into <em>{svc.data?.name ?? 'this service'}</em>.
          </>
        }
        description="An interactive shell inside a running container — over the agent's outbound link, nothing exposed."
        actions={
          <Button onClick={start} disabled={open.isPending || phase === 'connecting'}>
            <TerminalIcon className="size-4" />
            {phase === 'open' || phase === 'connecting' ? 'Reconnect' : 'Open shell'}
          </Button>
        }
      />

      {phase === 'disabled' && (
        <Alert className="card-pop mb-6 border-0">
          <AlertTitle>Container exec is off on this node</AlertTitle>
          <AlertDescription>
            {detail && !detail.startsWith('E_')
              ? detail
              : 'Turn Container exec back on in Nodes → this node → Controls. If it’s already on, the box is blocking it locally with SWARMY_ALLOW_EXEC=false in /etc/swarmy/agent.env — remove it and restart the agent.'}
          </AlertDescription>
        </Alert>
      )}

      {phase === 'error' && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn’t open the terminal</AlertTitle>
          <AlertDescription>{detail ?? 'Unexpected error.'}</AlertDescription>
        </Alert>
      )}

      <Card className="card-pop border-0">
        <CardContent className="p-2">
          {wsUrl ? (
            <div style={{ height: '60vh', minHeight: 360 }}>
              <WebTerminal wsUrl={wsUrl} onPhase={onPhase} />
            </div>
          ) : (
            <div className="text-muted-foreground p-16 text-center text-sm">
              Press <span className="font-semibold">Open shell</span> to drop into a container shell.
            </div>
          )}
        </CardContent>
      </Card>
      <StepUpDialog {...stepUp.dialog} />
    </div>
  );
}
