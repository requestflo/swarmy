import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
import type { ResilienceDrillKind, ResilienceDrillTargetView } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DRILL_TITLES } from './format';

const CONFIRM_COPY: Record<ResilienceDrillKind, string> = {
  restore:
    'This provisions a throwaway drill cluster, restores your latest backup into it, verifies SELECT 1, then destroys the clone. Your live cluster is never touched. Takes a few minutes.',
  failover:
    'This promotes a running standby so it briefly leads on its own, verifies it accepts writes, then force-restarts it to rejoin the cluster. Apps keep writing to the real primary throughout, but a replica leaves the chain for a minute.',
  'backup-verify':
    'This runs `restic check` against the backup destination in a one-shot container — read-only, safe to run any time.',
};

/** Confirm + run one drill. Failover needs an explicit "I understand" switch. */
export function RunDrillDialog({
  kind,
  targets,
  disabled,
  disabledReason,
}: {
  kind: ResilienceDrillKind;
  targets: ResilienceDrillTargetView[];
  disabled: boolean;
  disabledReason: string | null;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [ack, setAck] = React.useState(false);

  const failoverTargets = targets.filter(
    (t) => (t.topology === 'failover' || t.topology === 'primary-replica') && t.replicasRunning >= 1,
  );
  const pickable = kind === 'failover' ? failoverTargets : targets;
  const [target, setTarget] = React.useState<string>('');
  const selected = pickable.find((t) => `${t.stack}/${t.cluster}` === target) ?? pickable[0];

  const done = (status: string, summary: string): void => {
    if (status === 'passed') toast.success(summary);
    else toast.error(summary);
    setOpen(false);
    setAck(false);
    void qc.invalidateQueries();
  };
  const opts = {
    onSuccess: (r: { status: string; summary: string; error: string | null }) =>
      done(r.status, r.error ?? r.summary),
    onError: (e: { message: string }) => toast.error(e.message),
  };
  const restore = useMutation(trpc.resilience.runRestoreDrill.mutationOptions(opts));
  const failover = useMutation(trpc.resilience.runFailoverDrill.mutationOptions(opts));
  const verify = useMutation(trpc.resilience.runBackupVerify.mutationOptions(opts));
  const pending = restore.isPending || failover.isPending || verify.isPending;

  const run = (): void => {
    if (kind === 'backup-verify') return verify.mutate({});
    if (!selected) return;
    const ref = { stack: selected.stack, cluster: selected.cluster };
    if (kind === 'restore') restore.mutate(ref);
    else failover.mutate({ ...ref, acknowledge: true });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setAck(false); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} title={disabledReason ?? undefined}>
          <PlayIcon className="size-3.5" /> Run drill
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run the {DRILL_TITLES[kind].toLowerCase()}?</DialogTitle>
          <DialogDescription>{CONFIRM_COPY[kind]} Everything is audited.</DialogDescription>
        </DialogHeader>

        {kind !== 'backup-verify' && pickable.length > 0 ? (
          <div className="space-y-2">
            <Label className="text-sm font-medium">Database cluster</Label>
            <Select value={target || (selected ? `${selected.stack}/${selected.cluster}` : '')} onValueChange={setTarget}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a cluster" />
              </SelectTrigger>
              <SelectContent>
                {pickable.map((t) => (
                  <SelectItem key={`${t.stack}/${t.cluster}`} value={`${t.stack}/${t.cluster}`}>
                    {t.stack}/{t.cluster} · {t.topology}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {kind === 'failover' ? (
          <div className="flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
            <div>
              <Label className="text-sm font-medium">I understand a replica leaves the chain</Label>
              <p className="text-muted-foreground text-xs">
                The standby is promoted, verified, then restarted to re-sync from the primary.
              </p>
            </div>
            <Switch checked={ack} onCheckedChange={setAck} />
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || (kind === 'failover' && !ack) || (kind !== 'backup-verify' && !selected)}
            onClick={run}
          >
            {pending ? 'Running… this can take a few minutes' : `Run ${DRILL_TITLES[kind].toLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
