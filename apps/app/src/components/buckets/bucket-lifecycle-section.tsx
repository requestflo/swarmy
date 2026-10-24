import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LifecycleRuleInput } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { CodeView, Depth, Section, Tech } from '@/components/calm';
import { ErrorState, TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { lifeSay, lifecycleCode } from './lifecycle-model';
import { LifecycleRuleForm } from './lifecycle-rule-form';
import { LifecycleTimeline, timelineRows } from './lifecycle-timeline';
import { reachOrigin } from './reach-model';
import type { BucketAccessView } from './use-bucket-reach';

/** "Lifecycle — what happens to files as they age" (board 42), read from Garage. */
export function BucketLifecycleSection({ bucketId, access }: { bucketId: string; access: BucketAccessView | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const life = useQuery(trpc.buckets.getLifecycle.queryOptions({ bucketId }));
  const save = useMutation(
    trpc.buckets.setLifecycle.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.bucket}: ${lifeSay(r.rules)}`);
        void qc.invalidateQueries({ queryKey: trpc.buckets.getLifecycle.queryKey({ bucketId }) });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const v = life.data;
  const put = (rules: LifecycleRuleInput[]) => save.mutate({ bucketId, rules });

  return (
    <Section title="Lifecycle" hint="what happens to files as they age" count={v?.rules.length || undefined}>
      {life.isPending ? (
        <TextSkeleton className="h-4 w-3/4" />
      ) : !v ? (
        <ErrorState title="Couldn’t read this bucket’s age rules." error={life.error} retry={() => void life.refetch()} />
      ) : (
        <>
          <p className="text-muted-foreground text-[13px]">{lifeSay(v.rules)}</p>
          <LifecycleTimeline rows={timelineRows(v.rules)} busy={save.isPending} onRemove={(i) => put(v.rules.filter((_, k) => k !== i))} />
          <Tech>s3 lifecycle · expiration (days) + abort incomplete multipart upload, by prefix · garage runs it daily · no transitions</Tech>
          <Depth at="controls">
            <LifecycleRuleForm pending={save.isPending} onAdd={(rule) => put([...v.rules, rule])} />
          </Depth>
          <CodeView
            title="These rules as code"
            tabs={lifecycleCode({ bucket: v.bucket, endpoint: reachOrigin(access?.endpoints), rules: v.rules })}
            note="Stored on the bucket in Garage, not in swarmy.yaml. Any S3 client with a write key reads and sets the same rules."
          />
        </>
      )}
    </Section>
  );
}
