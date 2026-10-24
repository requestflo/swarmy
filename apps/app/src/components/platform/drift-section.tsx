import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { CalmRow, Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { REPIN_WHAT, driftHeadline, driftSay, driftTech, driftWhy, type DriftRowLite } from './drift-words';

/**
 * Settings › Platform → "Not on the release": swarmy's own services that run
 * something other than the release the cluster is on (live inventory vs the
 * manifest, `platform.drift`). Re-pin for the services an upgrade's system
 * step rolls; Explain for the ones only an upgrade moves. Quiet when nothing
 * drifts.
 */
export function DriftSection({ admin }: { admin: boolean }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.platform.drift.queryOptions(), refetchInterval: 60_000 });
  const v = q.data;
  if (!v || v.rows.length === 0) return null;
  return (
    <Section
      title={driftHeadline(v.rows.length, v.version)}
      hint={v.runActive ? 'an upgrade is moving them now — checked again when it finishes' : 'read live from the cluster'}
      flush
    >
      <div role="list">
        {v.rows.map((r) => (
          <DriftRow key={r.service} row={r} version={v.version} canRepin={admin && !v.runActive} />
        ))}
      </div>
    </Section>
  );
}

function DriftRow({ row, version, canRepin }: { row: DriftRowLite; version: string; canRepin: boolean }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const trpc = useTRPC();
  const qc = useQueryClient();
  const repin = useMutation(
    trpc.platform.repin.mutationOptions({
      onSuccess: (r) => {
        if (r.landed) toast.success(`${r.service} is back on ${version}.`);
        else toast.error(`${r.service} didn't come up healthy on ${version}, so Swarm put the old one back.`);
        void qc.invalidateQueries({ queryKey: trpc.platform.drift.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const trailing =
    row.action === 'repin' ? (
      canRepin ? (
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11 shrink-0" title={REPIN_WHAT} disabled={repin.isPending} onClick={() => repin.mutate({ service: row.service })}>
          {repin.isPending ? 'Re-pinning…' : 'Re-pin'}
        </Button>
      ) : null
    ) : (
      <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11 shrink-0" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Explain'}
      </Button>
    );
  return (
    <div role="listitem" className="border-border border-b last:border-b-0">
      <CalmRow tone="warn" className="border-b-0" name={row.service} say={driftSay(row, version)} tech={driftTech(row)} trailing={trailing} />
      {open ? <p className="text-muted-foreground px-6 pb-3 text-[13px] leading-snug">{driftWhy(row, version)}</p> : null}
    </div>
  );
}
