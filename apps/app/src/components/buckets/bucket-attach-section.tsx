import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinkIcon, UnlinkIcon } from 'lucide-react';
import type { BucketDetailView } from '@swarmy/core';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Attached apps: who is wired to this bucket (S3_* env + secret), plus a
 * picker to wire another service — swarmy mints the scoped key itself.
 */
export function BucketAttachSection({ bucket }: { bucket: BucketDetailView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [candidate, setCandidate] = React.useState('');
  const services = useQuery(trpc.services.list.queryOptions({}));

  const attach = useMutation(
    trpc.buckets.attachToService.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.appService} wired — S3_* env + secret injected`);
        setCandidate('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const detach = useMutation(
    trpc.buckets.detach.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.appService} detached`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const attached = new Set(bucket.attachments.map((a) => a.service));
  const candidates = (services.data ?? []).filter(
    (s) => !attached.has(s.name) && s.name !== 'swarmy-garage',
  );

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">Attached apps</p>
      {bucket.attachments.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Nothing wired yet — attaching a service injects <code className="mono-data">S3_ENDPOINT</code>,{' '}
          <code className="mono-data">S3_BUCKET</code>, a scoped key and the secret as a Docker secret.
        </p>
      ) : (
        <div className="border-border divide-border divide-y rounded-lg border">
          {bucket.attachments.map((a) => (
            <div key={a.service} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{a.service}</p>
                <p className="mono-data text-muted-foreground truncate text-xs">
                  key {a.accessKeyId || '—'}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={detach.isPending}
                onClick={() => detach.mutate({ appService: a.service })}
              >
                <UnlinkIcon className="size-4" /> Detach
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Select value={candidate} onValueChange={setCandidate}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Pick a service to attach…" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((s) => (
              <SelectItem key={s.id} value={s.name}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={!candidate || attach.isPending}
          onClick={() => attach.mutate({ bucketId: bucket.id, appService: candidate })}
        >
          <LinkIcon className="size-4" /> {attach.isPending ? 'Wiring…' : 'Attach'}
        </Button>
      </div>
    </section>
  );
}
