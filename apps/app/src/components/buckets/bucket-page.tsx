import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArchiveIcon } from 'lucide-react';
import { Button, EmptyState, cn } from '@swarmy/ui';
import { CalmPage, Say, SayHeader, TONE_DOT, Tech, type Crumb } from '@/components/calm';
import { PageError, SkeletonBody } from '@/components/states';
import { BucketAttachedSection } from './bucket-attached-section';
import { BucketCopiesSection } from './bucket-copies-section';
import { BucketCorsSection } from './bucket-cors-section';
import { BucketDelete } from './bucket-delete';
import { BucketKeysPanel } from './bucket-keys-panel';
import { BucketLifecycleSection } from './bucket-lifecycle-section';
import { BucketMoreControls } from './bucket-more-controls';
import { BucketReachAside } from './bucket-reach-aside';
import { BucketSizeSection } from './bucket-size-section';
import { BucketCode } from './bucket-summary';
import { fmtBytes } from './format';
import { REACH_LABEL, REACH_TONE, type ReachMode } from './reach-model';
import { useBucketPage } from './use-bucket-page';

/** A bucket's own page (board 42): who can reach it, size, copies, who uses it, its keys, delete. */
export function BucketPage({ name }: { name: string }): React.JSX.Element {
  const p = useBucketPage(name);
  const crumbs: Crumb[] = [{ label: 'Data', to: '/data' }, { label: 'Files & buckets', to: '/data/buckets' }, { label: name }];
  const b = p.bucket;
  const mode = p.access?.mode as ReachMode | undefined;

  if (p.pending) return <CalmPage crumbs={crumbs}><SkeletonBody variant="list" /></CalmPage>;
  if (p.error && !b) return <CalmPage crumbs={crumbs}><PageError error={p.error} retry={p.retry} /></CalmPage>;
  if (!b) {
    return (
      <CalmPage crumbs={crumbs}>
        <EmptyState
          icon={<ArchiveIcon />}
          title={`There’s no bucket called ${name}`}
          description="It may have been deleted, or the store isn’t answering."
          action={<Button variant="outline" asChild><Link to="/data/buckets">All buckets</Link></Button>}
        />
      </CalmPage>
    );
  }

  const apps = [...new Set(b.attachments.map((a) => a.stack))];
  return (
    <CalmPage
      crumbs={crumbs}
      meta={
        <>
          {mode ? (
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-semibold">
              <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[REACH_TONE[mode]])} />
              {REACH_LABEL[mode]}
            </span>
          ) : null}
          <Tech>garage · s3 · region {p.store?.region ?? 'swarmy'}</Tech>
        </>
      }
      aside={
        <>
          <BucketCode bucket={b} endpoint={p.store?.endpoint ?? null} mode={mode} />
          <BucketReachAside bucket={b} access={p.access} />
        </>
      }
    >
      <SayHeader
        title={
          <>
            {name} holds {fmtBytes(b.usageBytes)} in {b.objects.toLocaleString()} file{b.objects === 1 ? '' : 's'}.{' '}
            {mode === 'PUBLIC' ? <Say tone="warn">It is reachable from the internet.</Say> : mode === 'MESH' ? <em>Your private network can reach it too.</em> : <em>Only your apps can reach it.</em>}
          </>
        }
        lede={`${p.copies ? `Each file is kept on ${p.copies} server${p.copies === 1 ? '' : 's'}. ` : ''}${apps.length ? `Used by ${apps.join(', ')}.` : 'No app uses it yet.'}`}
      />
      <BucketSizeSection bucket={b} />
      <BucketCopiesSection copies={p.copies} members={p.members} />
      <BucketAttachedSection bucket={b} store={p.store} />
      <BucketKeysPanel bucket={b} endpoint={p.store?.endpoint ?? null} />
      <BucketLifecycleSection bucketId={b.id} access={p.access} />
      <BucketCorsSection bucketId={b.id} access={p.access} />
      <BucketMoreControls bucket={b} />
      <BucketDelete bucket={b} />
    </CalmPage>
  );
}
