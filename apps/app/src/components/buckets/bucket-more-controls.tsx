import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BucketDetailView } from '@swarmy/core';
import { Separator, Switch, toast } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { BucketPresignSection } from './bucket-presign-section';

/** Controls only: share one file by a signed link, and the public-website switch. */
export function BucketMoreControls({ bucket: b }: { bucket: BucketDetailView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const setWebsite = useMutation(
    trpc.buckets.setWebsite.mutationOptions({
      onSuccess: (r) => {
        toast[r.website ? 'warning' : 'success'](r.website ? `${r.name} now serves its files to anyone over HTTP` : `${r.name} no longer serves a website`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Depth at="controls">
      <Section title="Links and website">
        <BucketPresignSection bucket={b} />
        <Separator />
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Public website</p>
            <p className="text-muted-foreground text-xs">Serves files to anyone over HTTP, no key. Leave off for app data.</p>
          </div>
          <Switch
            checked={b.website}
            disabled={setWebsite.isPending}
            onCheckedChange={(enabled) => setWebsite.mutate({ bucketId: b.id, enabled })}
            aria-label="Public website"
          />
        </div>
      </Section>
    </Depth>
  );
}
