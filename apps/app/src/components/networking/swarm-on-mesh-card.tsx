import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, InfoIcon, RouteIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatusBadge,
  toast,
  type StatusTone,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

type Direction = 'onto-mesh' | 'off-mesh';

const STEP_LABEL: Record<string, string> = {
  pending: 'Queued',
  enrolling: 'Joining mesh',
  demoting: 'Demoting',
  draining: 'Draining',
  rejoining: 'Rejoining swarm',
  restoring: 'Restoring labels & pins',
  promoting: 'Promoting',
  cleanup: 'Cleaning up',
  done: 'Done',
};

const ACTION_LABEL: Record<string, string> = {
  move: 'Will move',
  'enroll-only': 'Joins mesh only',
  'stays-put': 'Stays put',
  already: 'On target',
};

/**
 * Networking → "Swarm on mesh". Reads as the last step of one flow:
 * 1 enable the mesh → 2 paste the control-plane token → 3 move the nodes.
 * Moving re-pins each node's swarm advertise + data-path address onto its
 * mesh IP, one node at a time (brief drain each), resumable on failure.
 */
export function SwarmOnMeshCard({
  meshLive,
  controlPlaneReady,
}: {
  meshLive: boolean;
  /** Control-plane token saved (or not needed — raw WireGuard). */
  controlPlaneReady: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const status = useQuery({
    ...trpc.mesh.swarmStatus.queryOptions(),
    refetchInterval: (q) => (q.state.data?.run?.status === 'running' ? 3_000 : 15_000),
  });
  const [confirm, setConfirm] = React.useState<Direction | null>(null);

  const invalidate = (): void => void qc.invalidateQueries();
  const onError = (e: { message: string }): void => void toast.error(e.message);
  const resume = useMutation(
    trpc.mesh.resumeMigration.mutationOptions({ onSuccess: () => (toast.success('Resuming the move'), invalidate()), onError }),
  );
  const cancel = useMutation(
    trpc.mesh.cancelMigration.mutationOptions({ onSuccess: () => (toast.success('Stopping after the current node'), invalidate()), onError }),
  );

  const run = status.data?.run ?? null;
  const plan = status.data?.plan;
  const running = run?.status === 'running';
  const stopped = run?.status === 'failed' || run?.status === 'canceled';
  const rows = plan?.nodes ?? [];
  const stepByNode = new Map(
    run && (running || stopped) ? run.nodes.map((n) => [n.nodeId, n] as const) : [],
  );
  const toMove = rows.filter((n) => n.action === 'move' || n.action === 'enroll-only').length;
  const onMeshCount = rows.filter((n) => n.onMesh).length;
  const allMoved = meshLive && rows.length > 0 && toMove === 0 && plan?.direction === 'onto-mesh';
  const stayingManager = plan?.managersStay ? rows.find((n) => n.kind === 'manager') : undefined;

  const steps = [
    { label: 'Mesh on', done: meshLive },
    { label: 'Control-plane token', done: controlPlaneReady },
    { label: 'Nodes on the mesh', done: allMoved },
  ];

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Swarm on mesh</CardTitle>
            <CardDescription>
              Docker fixes a node’s swarm address when it joins. Moving re-joins each node on its mesh IP
              — one at a time, a brief drain each — so swarm and overlay traffic ride WireGuard.
            </CardDescription>
          </div>
          <ol className="flex flex-wrap items-center gap-2">
            {steps.map((s, i) => (
              <li
                key={s.label}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                  s.done ? 'bg-status-online/12 text-status-online' : 'bg-accent text-muted-foreground'
                }`}
              >
                {s.done ? <CheckIcon className="size-3.5" /> : <span className="mono-data">{i + 1}</span>}
                {s.label}
              </li>
            ))}
          </ol>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {stayingManager && (
          <div className="bg-accent/40 flex gap-3 rounded-xl px-4 py-3 text-sm">
            <InfoIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <p>
              <strong>{stayingManager.hostname}</strong> stays on its public address — NAT’d nodes connect
              out to it, and it reaches them over the mesh. Keep 2377/tcp, 7946 and 4789/udp open on it.
              {plan && plan.managerCount < 3 && ' (With 3+ managers they move too, one at a time.)'}
            </p>
          </div>
        )}

        {run?.error && stopped && (
          <div className="border-status-offline/40 bg-status-offline/12 rounded-xl border px-4 py-3">
            <p className="text-status-offline text-sm font-medium">
              {run.status === 'canceled' ? 'Move stopped.' : 'Move stopped part-way.'}
            </p>
            <p className="text-status-offline mt-1 whitespace-pre-wrap text-xs">{run.error}</p>
          </div>
        )}

        <div className="divide-border overflow-hidden rounded-xl border">
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-4 py-6 text-sm">No nodes have reported yet — add one.</p>
          ) : (
            <ul className="divide-border divide-y">
              {rows.map((n) => {
                const live = stepByNode.get(n.nodeId);
                const tone: StatusTone = live?.error
                  ? 'offline'
                  : live && live.step !== 'done' && live.step !== 'pending'
                    ? 'progress'
                    : n.onMesh
                      ? 'online'
                      : 'neutral';
                const label = live?.error
                  ? `Failed · ${STEP_LABEL[live.step] ?? live.step}`
                  : live
                    ? (STEP_LABEL[live.step] ?? live.step)
                    : (ACTION_LABEL[n.action] ?? n.action);
                return (
                  <li key={n.nodeId} className="hover:bg-accent/40 flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3">
                    <div className="min-w-[10rem]">
                      <p className="font-medium">{n.hostname}</p>
                      <p className="mono-label text-muted-foreground">
                        {n.kind}
                        {n.leader ? ' · leader' : ''}
                      </p>
                    </div>
                    <div className="min-w-[9rem]">
                      <p className="mono-label text-muted-foreground">Swarm address</p>
                      <p className="mono-data text-sm">{n.addr ?? '—'}</p>
                    </div>
                    <div className="min-w-[8rem]">
                      <p className="mono-label text-muted-foreground">Mesh IP</p>
                      <p className="mono-data text-sm">{n.meshIp ?? '—'}</p>
                    </div>
                    <StatusBadge tone={n.onMesh ? 'online' : 'neutral'} label={n.onMesh ? 'On mesh' : 'Off mesh'} />
                    <div className="ml-auto text-right">
                      <StatusBadge tone={tone} label={label} />
                      {live?.error ? (
                        <p className="text-status-offline mt-1 max-w-md text-xs">{live.error}</p>
                      ) : (
                        <p className="text-muted-foreground mt-1 max-w-md text-xs">{n.reason}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {running && (
            <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Stop after this node
            </Button>
          )}
          {stopped && (
            <Button disabled={resume.isPending} onClick={() => resume.mutate()}>
              Resume move
            </Button>
          )}
          {!running && !stopped && onMeshCount > 0 && (
            <Button variant="outline" onClick={() => setConfirm('off-mesh')}>
              Move back off the mesh
            </Button>
          )}
          {!running && !stopped && (
            <Button
              disabled={!meshLive || !controlPlaneReady || toMove === 0 || (plan?.blockers.length ?? 0) > 0}
              onClick={() => setConfirm('onto-mesh')}
              className="shadow-[0_8px_24px_-8px_var(--primary)] hover:scale-[1.03]"
            >
              <RouteIcon className="size-4" /> Move swarm onto mesh
            </Button>
          )}
        </div>
        {!running && !stopped && (plan?.blockers.length ?? 0) > 0 && (
          <p className="text-status-warning text-right text-xs">{plan!.blockers.join(' ')}</p>
        )}
        {!meshLive && (
          <p className="text-muted-foreground text-right text-xs">Turn the mesh on and save the control-plane token first.</p>
        )}
      </CardContent>

      <MoveSwarmDialog direction={confirm} onClose={() => setConfirm(null)} />
    </Card>
  );
}

/**
 * The confirm for either direction. Loads that direction's plan so the
 * warnings (pinned data, controller host, NAT'd nodes) are shown and
 * acknowledged before anything drains. `disableWhenDone` turns the mesh off
 * after an off-mesh move (the Disable path).
 */
export function MoveSwarmDialog({
  direction,
  onClose,
  disableWhenDone = false,
}: {
  direction: Direction | null;
  onClose: () => void;
  disableWhenDone?: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const preview = useQuery({
    ...trpc.mesh.swarmStatus.queryOptions({ direction: direction ?? 'onto-mesh' }),
    enabled: direction !== null,
  });
  const migrate = useMutation(
    trpc.mesh.migrateSwarm.mutationOptions({
      onSuccess: () => {
        toast.success(direction === 'off-mesh' ? 'Moving the swarm off the mesh' : 'Moving the swarm onto the mesh');
        onClose();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const plan = preview.data?.plan;
  const moving = plan?.nodes.filter((n) => n.action === 'move') ?? [];
  const enrolling = plan?.nodes.filter((n) => n.action === 'enroll-only') ?? [];
  const off = direction === 'off-mesh';

  return (
    <AlertDialog open={direction !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {off
              ? disableWhenDone
                ? 'Move the swarm off the mesh, then turn it off?'
                : 'Move the swarm off the mesh?'
              : 'Move the swarm onto the mesh?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {moving.length === 0 && enrolling.length === 0
              ? 'Nothing to move.'
              : `One node at a time: drain it (its tasks move to other nodes), re-join the swarm on ${
                  off ? 'its own address' : 'its mesh IP'
                }, put its labels and data pins back, then bring it back into service. Each node is out for about a minute. If a step fails the move stops there and you can resume it.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {(moving.length > 0 || enrolling.length > 0) && (
          <ul className="grid gap-1 text-sm">
            {enrolling.map((n) => (
              <li key={n.nodeId}>
                <span className="font-medium">{n.hostname}</span>{' '}
                <span className="text-muted-foreground">— joins the mesh, keeps its address</span>
              </li>
            ))}
            {moving.map((n, i) => (
              <li key={n.nodeId}>
                <span className="mono-data text-muted-foreground mr-2">{i + 1}.</span>
                <span className="font-medium">{n.hostname}</span>{' '}
                <span className="mono-data text-muted-foreground">
                  {n.addr ?? '?'} → {off ? 'own address' : (n.meshIp ?? 'mesh IP')}
                </span>
              </li>
            ))}
          </ul>
        )}

        {(plan?.warnings.length ?? 0) > 0 && (
          <div className="border-status-warning/40 bg-status-warning/12 grid gap-1 rounded-xl border px-4 py-3">
            {plan!.warnings.map((w) => (
              <p key={w} className="text-xs">
                {w}
              </p>
            ))}
          </div>
        )}
        {(plan?.blockers.length ?? 0) > 0 && (
          <p className="text-status-offline text-xs">{plan!.blockers.join(' ')}</p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction
            disabled={
              !plan ||
              migrate.isPending ||
              plan.blockers.length > 0 ||
              (moving.length === 0 && enrolling.length === 0 && !disableWhenDone)
            }
            onClick={(e) => {
              e.preventDefault();
              if (!direction) return;
              migrate.mutate({ direction, acknowledgeWarnings: true, disableWhenDone: off && disableWhenDone });
            }}
          >
            {off ? (disableWhenDone ? 'Move off & turn off' : 'Move off the mesh') : 'Move swarm onto mesh'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
