import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AlertEventView, ReleaseView } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';

/** What the glance just did, shown in place of the incident card. */
export type GlanceDone =
  | { kind: 'put-back'; incidentId: string; app: string; label: string; suspect: ReleaseView | null; releaseId: string }
  | { kind: 'ack'; incidentId: string; count: number };

export interface GlanceActions {
  busy: boolean;
  /** Put `to` back (`releases.rollback`); Undo puts `suspect` back again. */
  putBack: (incidentId: string, to: ReleaseView, suspect: ReleaseView | null) => void;
  undo: (suspect: ReleaseView) => void;
  /** `alerts.ack` every alert behind the incident. Not reversible, so no Undo. */
  ack: (incidentId: string, events: AlertEventView[]) => void;
}

const PUT_BACK_TOAST = 'glance-put-back';

/**
 * The glance's inline actions. A put-back is reversible (the version it
 * replaced goes back out the same way), so its toast carries Undo; an ack
 * resolves the alert events and has no way back.
 */
export function useGlanceActions(setDone: (d: GlanceDone | null) => void): GlanceActions {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const settle = { onSettled: () => void qc.invalidateQueries(), onError: (e: { message: string }) => void toast.error(e.message) };
  const rollback = useMutation(trpc.releases.rollback.mutationOptions(settle));
  const acking = useMutation(trpc.alerts.ack.mutationOptions(settle));

  const undo = (suspect: ReleaseView): void => {
    const label = releaseLabel(suspect);
    toast.dismiss(PUT_BACK_TOAST);
    rollback.mutate(
      { releaseId: suspect.id },
      {
        onSuccess: () => {
          setDone(null);
          toast.success(`Putting ${label} of ${suspect.stackName} back out, one copy at a time.`);
        },
      },
    );
  };

  const putBack = (incidentId: string, to: ReleaseView, suspect: ReleaseView | null): void => {
    const label = releaseLabel(to);
    rollback.mutate(
      { releaseId: to.id },
      {
        onSuccess: (r) => {
          setDone({ kind: 'put-back', incidentId, app: to.stackName, label, suspect, releaseId: r.releaseId });
          toast.success(
            `Putting back ${label} of ${to.stackName}, one copy at a time.`,
            suspect ? { id: PUT_BACK_TOAST, duration: 10_000, action: { label: 'Undo', onClick: () => undo(suspect) } } : undefined,
          );
        },
      },
    );
  };

  const ack = (incidentId: string, events: AlertEventView[]): void => {
    void Promise.all(events.map((e) => acking.mutateAsync({ id: e.id }))).then(
      () => {
        setDone({ kind: 'ack', incidentId, count: events.length });
        toast.success(events.length === 1 ? 'Alert acknowledged.' : `${events.length} alerts acknowledged.`);
      },
      () => undefined,
    );
  };

  return { busy: rollback.isPending || acking.isPending, putBack, undo, ack };
}
