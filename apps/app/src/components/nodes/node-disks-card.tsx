import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDriveIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  toast,
} from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { bytes } from '@/lib/format';

/**
 * Add a disk (plans/epic-volume-mobility.md phase 1): the server's attached
 * disks. A new, empty disk can be formatted (typed last 4 of its serial) and
 * new data goes there; a disk grown in the cloud console can be grown here.
 * A disk swarmy formatted that is not attached (QA-075b) says so, with what
 * was written to the root disk meanwhile; swarmy attaches it on its own, and
 * "Attach it now" does it at once. "Make default" picks which mounted swarmy
 * disk new data goes to. Renders nothing while the server is
 * offline or has only its system disk.
 */
export function NodeDisksCard({ nodeId, online }: { nodeId: string; online: boolean }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const disks = useQuery({ ...trpc.disks.list.queryOptions({ nodeId }), enabled: online, retry: false, refetchInterval: 60_000 });
  const done = (msg: string) => {
    toast.success(msg);
    void qc.invalidateQueries({ queryKey: trpc.disks.list.queryKey({ nodeId }) });
  };
  const format = useMutation(trpc.disks.format.mutationOptions({ onSuccess: (r) => done(`Disk ready at ${r.mountpoint}`), onError: (e) => toast.error(e.message) }));
  const grow = useMutation(trpc.disks.grow.mutationOptions({ onSuccess: () => done('Disk grown'), onError: (e) => toast.error(e.message) }));
  const setDefault = useMutation(
    trpc.disks.setDefault.mutationOptions({ onSuccess: () => done('New data now goes to this disk'), onError: (e) => toast.error(e.message) }),
  );
  const repair = useMutation(
    trpc.disks.repair.mutationOptions({
      onSuccess: (r) => done(r.moved ? `Disk attached — moved ${bytes(r.bytes)} onto it` : 'Disk attached'),
      onError: (e) => toast.error(e.message),
    }),
  );
  const [confirm, setConfirm] = React.useState('');

  const v = disks.data;
  const shown = (v?.disks ?? []).filter((d) => d.state !== 'system');
  if (!v || (shown.length === 0 && v.warnings.length === 0)) return null;

  return (
    <Card className="calm-card border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HardDriveIcon className="text-primary size-4" />
          Disks
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-border grid grid-cols-1 divide-y">
        {v.warnings.map((w) => (
          <p key={w.diskId} role="status" className="text-tone-warn py-2.5 text-sm">
            {w.message}
          </p>
        ))}
        {v.lastRepair && v.lastRepair.bytes > 0 ? (
          <p className="py-2.5 text-sm">
            Moved {bytes(v.lastRepair.bytes)} written before the disk was attached.
            {v.lastRepair.aside ? <Tech className="block">originals kept at {v.lastRepair.aside}</Tech> : null}
          </p>
        ) : null}
        {shown.map((d) => (
          <div key={d.path} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
            <span>
              <span className="mono-data">{d.name}</span> <span className="text-muted-foreground">{bytes(d.sizeBytes)}</span>
              {d.serial ? <span className="text-muted-foreground"> · serial …{d.serial.slice(-4)}</span> : null}
              {d.isDefault ? <span className="text-muted-foreground"> · new data goes here</span> : null}
              <span className="text-muted-foreground block">
                {d.state === 'swarmy-unmounted' ? 'Set up by swarmy, but not attached yet — swarmy attaches it on its own.' : d.reason}
              </span>
              {d.state === 'swarmy-unmounted' && d.pending ? (
                <span className="text-muted-foreground block">
                  {d.pending.bytes > 0 ? `${bytes(d.pending.bytes)} was written to the system disk meanwhile; it moves onto this disk. ` : ''}
                  {d.pending.services.length > 0 ? `Used by ${d.pending.services.join(', ')}.` : ''}
                </span>
              ) : null}
            </span>
            {d.state === 'blank' && d.serial ? (
              v.formatAllowed ? (
                <AlertDialog onOpenChange={() => setConfirm('')}>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" disabled={format.isPending}>Format and use</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Format {d.name} ({bytes(d.sizeBytes)})?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Swarmy formats it (ext4), mounts it at /var/lib/swarmy/disks and puts new data there. Type the
                        last 4 characters of its serial ({d.serial.slice(-4)}) to confirm.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Last 4 of the serial" aria-label="Last 4 of the serial" />
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <Button
                        disabled={confirm.trim().toUpperCase() !== d.serial.slice(-4).toUpperCase() || format.isPending}
                        onClick={() => format.mutate({ nodeId, path: d.path, serial: d.serial!, sizeBytes: d.sizeBytes, confirm })}
                      >
                        Format
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <span className="text-muted-foreground">{v.formatBlockedReason}</span>
              )
            ) : null}
            {d.state === 'swarmy-unmounted' && d.serial ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" disabled={repair.isPending} className="pointer-coarse:min-h-11">
                    {repair.isPending ? 'Attaching…' : 'Attach it now'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Attach {d.name} now?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {d.pending?.services.length
                        ? `swarmy stops ${d.pending.services.join(', ')} for a moment, `
                        : 'swarmy '}
                      {d.pending && d.pending.bytes > 0
                        ? `copies the ${bytes(d.pending.bytes)} written meanwhile onto the disk and checks every file (the originals are kept), `
                        : ''}
                      attaches the disk{d.pending?.services.length ? ', then starts them again' : ''}. Nothing is deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <Button disabled={repair.isPending} onClick={() => repair.mutate({ nodeId, serial: d.serial! })}>
                      Attach
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            {d.state === 'swarmy' && !d.isDefault && d.id ? (
              <Button
                size="sm"
                variant="outline"
                disabled={setDefault.isPending}
                className="pointer-coarse:min-h-11"
                onClick={() => setDefault.mutate({ nodeId, diskId: d.id! })}
              >
                Make default
              </Button>
            ) : null}
            {d.state === 'swarmy' && d.growableBytes > 0 && d.serial ? (
              <Button size="sm" variant="ghost" disabled={grow.isPending} onClick={() => grow.mutate({ nodeId, serial: d.serial! })}>
                Grow by {bytes(d.growableBytes)}
              </Button>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
