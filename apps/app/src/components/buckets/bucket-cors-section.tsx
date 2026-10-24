import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { isDevOrigin, type BucketCorsView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { CodeView, Depth, Section, Tech } from '@/components/calm';
import { ErrorState, TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { BucketCorsForm } from './bucket-cors-form';
import { corsCode, corsSay, maxAgeLabel, methodLabel } from './cors-model';
import { reachOrigin, type ReachMode } from './reach-model';
import { useCorsDraft } from './use-cors-draft';
import type { BucketAccessView } from './use-bucket-reach';

/** "Browsers allowed to fetch directly" (board 42): the bucket's CORS rules, read from Garage. */
export function BucketCorsSection({ bucketId, access }: { bucketId: string; access: BucketAccessView | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const cors = useQuery(trpc.buckets.getCors.queryOptions({ bucketId }));
  const v = cors.data;
  return (
    <Section title="Browsers allowed to fetch directly" count={v?.origins.length || undefined}>
      {cors.isPending ? (
        <TextSkeleton className="h-4 w-3/4" />
      ) : !v ? (
        <ErrorState title="Couldn’t read this bucket’s browser rules." error={cors.error} retry={() => void cors.refetch()} />
      ) : (
        <CorsBody key={JSON.stringify(v.rules)} view={v} access={access} />
      )}
    </Section>
  );
}

/** The origins (removable at Controls), methods, preflight cache, the editor and the Code view. */
function CorsBody({ view: v, access }: { view: BucketCorsView; access: BucketAccessView | undefined }): React.JSX.Element {
  const d = useCorsDraft(v);
  return (
    <>
      <p className="text-muted-foreground text-[13px]">{corsSay(v.origins, access?.mode as ReachMode | undefined)}</p>
      {d.origins.length > 0 ? (
        <ul className="flex flex-col">
          {d.origins.map((o) => (
            <li key={o} className="border-border flex min-h-10 items-center gap-2 border-b py-1 last:border-b-0">
              <code className="mono-data min-w-0 flex-1 truncate text-[13px]">{o}</code>
              {isDevOrigin(o) ? <span className="bg-muted rounded-full px-2 py-0.5 text-[11px] font-semibold">dev</span> : null}
              {v.origins.includes(o) ? null : <span className="text-tone-info text-[11px] font-semibold">not saved</span>}
              <Depth at="controls">
                <Button variant="ghost" size="icon" className="size-8 pointer-coarse:size-11" aria-label={`Remove ${o}`} onClick={() => d.remove(o)}>
                  <XIcon className="size-4" />
                </Button>
              </Depth>
            </li>
          ))}
        </ul>
      ) : null}
      {v.origins.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">Methods</dt>
          <dd className="font-mono text-[12.5px]">{v.methods.map(methodLabel).join(' · ')}</dd>
          <dt className="text-muted-foreground">Cache preflight</dt>
          <dd>{maxAgeLabel(v.maxAgeSeconds)}</dd>
        </dl>
      ) : null}
      <Tech>
        s3 cors · one rule per origin · headers * · exposes ETag{v.wildcards ? ' · https://*.domain patterns ok' : ' · exact origins (garage v1)'}
        {v.uniform ? '' : ' · rules set outside swarmy differ; saving replaces them'}
      </Tech>
      <Depth at="controls">
        <BucketCorsForm draft={d} wildcards={v.wildcards} />
      </Depth>
      <CodeView
        title="These rules as code"
        tabs={corsCode({ bucket: v.bucket, endpoint: reachOrigin(access?.endpoints), rules: v.rules })}
        note="Stored on the bucket in Garage, not in swarmy.yaml. Any S3 client with an owner key reads and sets the same rules."
      />
    </>
  );
}
