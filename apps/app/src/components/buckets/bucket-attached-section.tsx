import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UnlinkIcon } from 'lucide-react';
import type { BucketDetailView, BucketsOverview } from '@swarmy/core';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { ATTACH_ENV } from './attach-plan';
import { AttachPreview } from './attach-preview';
import { attachedRows } from './bucket-facts';
import { useAttachCandidates } from './use-attach-candidates';

const ENV_WORDS = ATTACH_ENV.map((k) => (k.endsWith('_FILE') ? `${k.replace(/_FILE$/, '')} (file)` : k)).join(' · ');

/** "Attached to": each app / service, the variables it got, read-write or read. Attach and detach at Controls. */
export function BucketAttachedSection({ bucket: b, store }: { bucket: BucketDetailView; store: BucketsOverview | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [app, setApp] = React.useState<string | null>(null);
  const { apps, candidates } = useAttachCandidates(app);
  const detach = useMutation(
    trpc.buckets.detach.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.appService} detached · its S3 variables are gone`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rows = attachedRows(b);
  return (
    <Section title="Attached to" count={rows.length || undefined}>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">No app uses it yet. Attach one and swarmy adds the variables and a key of its own.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.serviceName} className="border-border flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
              <span className="shrink-0 font-mono text-[13px] font-semibold sm:w-40">
                {r.app} / {r.service}
              </span>
              <span className="text-muted-foreground order-last min-w-0 basis-full font-mono text-[11.5px] sm:order-none sm:flex-1 sm:basis-0">{ENV_WORDS}</span>
              <span className="bg-muted ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold sm:ml-0">{r.perm}</span>
              <Depth at="controls">
                <Button variant="outline" size="sm" disabled={detach.isPending} onClick={() => detach.mutate({ appService: r.serviceName })}>
                  <UnlinkIcon className="size-4" /> Detach
                </Button>
              </Depth>
            </li>
          ))}
        </ul>
      )}
      <Depth at="controls">
        {app ? (
          candidates ? (
            <AttachPreview
              target={{ bucketId: b.id, bucket: b.name, app }}
              candidates={candidates}
              endpoint={store?.endpoint ?? null}
              region={store?.region ?? 'swarmy'}
              onClose={() => setApp(null)}
            />
          ) : (
            <CardSkeleton lines={2} />
          )
        ) : (
          <Select value="" onValueChange={setApp}>
            <SelectTrigger className="h-9 w-auto min-w-48 pointer-coarse:min-h-11" aria-label={`Attach ${b.name} to an app`}>
              <SelectValue placeholder="Attach to an app…" />
            </SelectTrigger>
            <SelectContent>
              {apps.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Depth>
    </Section>
  );
}
