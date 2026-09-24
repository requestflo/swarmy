import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, CircleCheckIcon, CircleDotIcon, LogOutIcon, TriangleAlertIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  type StatusTone,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

type Downtime = 'none' | 'seconds' | 'short' | 'unknown';

const PAUSE: Record<Downtime, { label: string; tone: StatusTone }> = {
  none: { label: 'No pause', tone: 'online' },
  seconds: { label: 'A few seconds', tone: 'progress' },
  short: { label: 'About a minute', tone: 'warning' },
  unknown: { label: 'Longer (restore)', tone: 'offline' },
};

const RUN_TONE: Record<string, StatusTone> = {
  running: 'progress',
  waiting: 'warning',
  interrupted: 'warning',
  stopped: 'neutral',
  failed: 'offline',
  done: 'online',
};

/**
 * "Retire this server" — the one-button decommission (plans/epic-volume-mobility.md).
 * Three layers over one plan: Summary (a sentence, what blocks it, what to
 * accept), Steps (each move, where it lands, how long anything pauses) and
 * Commands (what swarmy will actually run, how it checks, how it undoes). The
 * run itself goes step by step in the background; this card follows it.
 */
export function NodeRetirePanel({ nodeId }: { nodeId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [planning, setPlanning] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);
  const [typed, setTyped] = React.useState('');

  const status = useQuery({
    ...trpc.decommission.status.queryOptions({ id: nodeId }),
    refetchInterval: (q) => (q.state.data && ['running', 'waiting'].includes(q.state.data.status) ? 2_000 : 15_000),
  });
  const plan = useQuery({ ...trpc.decommission.plan.queryOptions({ id: nodeId }), enabled: planning, staleTime: 30_000 });

  const start = useMutation(
    trpc.decommission.start.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Retiring ${r.hostname}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const stop = useMutation(
    trpc.decommission.stop.mutationOptions({
      onSuccess: () => {
        toast.success('Stopping after the current step');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const run = status.data;
  if (run && run.status !== 'done') {
    const live = run.status === 'running';
    return (
      <Card className="card-pop mt-6 border-0">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <LogOutIcon className="text-primary size-4" /> Retiring {run.hostname}
            <StatusBadge tone={RUN_TONE[run.status] ?? 'neutral'} label={run.status} />
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            {live ? (
              <Button size="sm" variant="outline" disabled={stop.isPending} onClick={() => stop.mutate({ id: nodeId })}>
                Stop after this step
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={start.isPending}
                onClick={() => start.mutate({ id: nodeId, confirmHostname: run.hostname, acceptWarnings: true })}
              >
                Resume
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {run.current ? (
            <p className="flex items-center gap-2 text-sm font-medium">
              <span className="pulse-dot" /> {run.current.title}
            </p>
          ) : null}
          {run.error ? <p className="text-destructive text-sm">{run.error}</p> : null}
          {run.status === 'interrupted' ? (
            <p className="text-muted-foreground text-sm">
              The controller restarted mid-run. Resume re-checks the server and carries on after the last finished step.
            </p>
          ) : null}
          <p className="mono-label text-muted-foreground">{run.done.length} steps done</p>
          <div className="divide-border grid max-h-72 grid-cols-1 divide-y overflow-y-auto">
            {[...run.log].reverse().map((l, i) => (
              <div key={`${l.at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-sm">
                <span className={l.level === 'error' ? 'text-destructive' : l.level === 'warn' ? 'text-status-warning' : ''}>
                  {l.message}
                </span>
                <span className="mono-data text-muted-foreground text-xs">{new Date(l.at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const p = plan.data;
  const needsAck = (p?.warnings.length ?? 0) > 0;
  const canStart = Boolean(p?.runnable) && typed.trim() === p?.node.hostname && (!needsAck || accepted);

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <LogOutIcon className="text-primary size-4" /> Retire this server
        </CardTitle>
        {!planning ? (
          <Button size="sm" variant="outline" onClick={() => setPlanning(true)}>
            Plan retirement
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={plan.isFetching} onClick={() => void plan.refetch()}>
            {plan.isFetching ? 'Checking…' : 'Re-check'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!planning ? (
          <p className="text-muted-foreground text-sm">
            Moves every app, database and volume on this server to your other servers, then removes it from the swarm.
            You see the whole plan before anything happens, and nothing on its disk is deleted.
          </p>
        ) : plan.isPending ? (
          <div className="shimmer-line h-16 rounded-xl" />
        ) : plan.error ? (
          <p className="text-destructive text-sm">{plan.error.message}</p>
        ) : p ? (
          <Tabs defaultValue="summary">
            <TabsList>
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="steps">Steps ({p.steps.length})</TabsTrigger>
              <TabsTrigger value="code">Commands</TabsTrigger>
            </TabsList>

            <TabsContent value="summary" className="space-y-4 pt-4">
              <p className="text-base font-medium">{p.summary}</p>
              {p.blockers.length > 0 ? (
                <div className="space-y-2">
                  {p.blockers.map((b) => (
                    <div key={`${b.code}-${b.subject ?? ''}`} className="bg-destructive/5 rounded-xl p-3 text-sm">
                      <p className="text-destructive flex items-center gap-2 font-medium">
                        <TriangleAlertIcon className="size-4" /> {b.message}
                      </p>
                      {b.fix ? <p className="text-muted-foreground mt-1">{b.fix}</p> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {p.warnings.length > 0 ? (
                <div className="space-y-2">
                  <p className="mono-label text-muted-foreground">Before you start</p>
                  <ul className="space-y-1 text-sm">
                    {p.warnings.map((w) => (
                      <li key={w} className="flex gap-2">
                        <TriangleAlertIcon className="text-status-warning mt-0.5 size-4 shrink-0" /> {w}
                      </li>
                    ))}
                  </ul>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                    I understand
                  </label>
                </div>
              ) : null}
              {p.runnable ? (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="grid gap-1">
                    <span className="text-muted-foreground text-xs">
                      Type <span className="mono-data">{p.node.hostname}</span> to confirm
                    </span>
                    <Input className="w-64" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
                  </div>
                  <Button
                    variant="destructive"
                    disabled={!canStart || start.isPending}
                    onClick={() => start.mutate({ id: nodeId, confirmHostname: typed.trim(), acceptWarnings: accepted })}
                  >
                    Retire {p.node.hostname}
                  </Button>
                </div>
              ) : null}
            </TabsContent>

            <TabsContent value="steps" className="pt-4">
              <ol className="divide-border grid grid-cols-1 divide-y">
                {p.steps.map((s, i) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="flex items-center gap-2">
                      <span className="mono-data text-muted-foreground w-6 text-xs">{i + 1}</span>
                      {s.title}
                      {s.destination ? (
                        <span className="text-muted-foreground flex items-center gap-1 text-xs">
                          <ArrowRightIcon className="size-3" /> {s.destination.hostname}
                        </span>
                      ) : null}
                    </span>
                    <StatusBadge tone={PAUSE[s.downtime as Downtime].tone} label={PAUSE[s.downtime as Downtime].label} />
                  </li>
                ))}
              </ol>
            </TabsContent>

            <TabsContent value="code" className="space-y-3 pt-4">
              {p.steps.map((s) => (
                <div key={s.id} className="rounded-xl border p-3">
                  <p className="mono-label flex items-center gap-2">
                    <CircleDotIcon className="size-3" /> {s.kind}
                    {s.subject ? <span className="text-muted-foreground normal-case">{s.subject}</span> : null}
                  </p>
                  <p className="mono-data mt-2 text-xs leading-relaxed">{s.detail}</p>
                  <p className="text-muted-foreground mt-2 flex gap-2 text-xs">
                    <CircleCheckIcon className="size-3.5 shrink-0" /> {s.verify}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">Undo: {s.rollback}</p>
                </div>
              ))}
            </TabsContent>
          </Tabs>
        ) : null}
      </CardContent>
    </Card>
  );
}
