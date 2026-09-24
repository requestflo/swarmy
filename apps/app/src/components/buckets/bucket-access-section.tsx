import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GlobeIcon, LockIcon, NetworkIcon } from 'lucide-react';
import { Button, CopyButton, Input, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

type Mode = 'INTERNAL' | 'MESH' | 'PUBLIC';

const MODES: Array<{ mode: Mode; label: string; icon: typeof LockIcon; blurb: string }> = [
  {
    mode: 'INTERNAL',
    label: 'Internal',
    icon: LockIcon,
    blurb: 'Only apps and services inside swarmy. Nothing is routed from outside.',
  },
  {
    mode: 'MESH',
    label: 'Mesh',
    icon: NetworkIcon,
    blurb: 'Plus devices on your mesh network, via any edge node’s mesh IP.',
  },
  {
    mode: 'PUBLIC',
    label: 'Public',
    icon: GlobeIcon,
    blurb: 'Plus the internet, over HTTPS on your public S3 domain.',
  },
];

/**
 * Who can reach this bucket's S3 API. The edges enforce it — only exposed
 * buckets are routed, everything else is refused before it reaches storage —
 * and every request still needs an access key or a presigned link.
 */
export function BucketAccessSection({ bucketId }: { bucketId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const access = useQuery(trpc.buckets.access.queryOptions({ bucketId }));
  const [domainDraft, setDomainDraft] = React.useState<string | null>(null);

  const setAccess = useMutation(
    trpc.buckets.setAccess.mutationOptions({
      onSuccess: (v) => {
        const msg =
          v.mode === 'PUBLIC'
            ? `"${v.bucket}" is reachable from the internet at ${v.endpoints.public ?? 'its public domain'} (keys still required)`
            : v.mode === 'MESH'
              ? `"${v.bucket}" is reachable from your mesh`
              : `"${v.bucket}" is internal-only again`;
        toast[v.mode === 'PUBLIC' ? 'warning' : 'success'](msg);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setDomain = useMutation(
    trpc.buckets.setPublicDomain.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.domain ? `Public S3 domain set to ${r.domain}` : 'Public S3 domain reset to the default');
        setDomainDraft(null);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const v = access.data;
  if (!v) return <div className="shimmer-line h-24 rounded-lg" />;

  const pending = setAccess.isPending;
  const endpoints: Array<{ label: string; url: string }> = [
    ...(v.endpoints.public ? [{ label: 'Internet', url: v.endpoints.public }] : []),
    ...v.endpoints.mesh.map((url) => ({ label: 'Mesh', url })),
    { label: 'Inside swarmy', url: v.endpoints.internal },
  ];

  return (
    <section className="space-y-3">
      <div>
        <p className="mono-label text-muted-foreground !mb-0">Access</p>
        <p className="text-muted-foreground text-xs">
          Who can reach this bucket’s S3 API. Every request still needs an access key or a presigned
          link — “public” means reachable, not anonymous.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Bucket access">
        {MODES.map(({ mode, label, icon: Icon, blurb }) => {
          const on = v.mode === mode;
          const unavailable =
            (mode === 'MESH' && !v.meshAvailable) || (mode === 'PUBLIC' && !v.publicDomain);
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={pending || (unavailable && !on)}
              onClick={() => !on && setAccess.mutate({ bucketId, mode })}
              className={cn(
                'rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                on ? 'bg-ink text-ink-foreground border-transparent' : 'bg-card hover:bg-accent',
              )}
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Icon className="size-4" /> {label}
              </span>
              <span className={cn('mt-1 block text-xs', on ? 'opacity-80' : 'text-muted-foreground')}>
                {mode === 'MESH' && !v.meshAvailable
                  ? 'Needs the mesh (Networking → Mesh) and an edge node on it.'
                  : mode === 'PUBLIC' && !v.publicDomain
                    ? 'Set a public S3 domain below first.'
                    : blurb}
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5">
        {endpoints.map((e) => (
          <div key={e.url} className="bg-card flex items-center gap-2 rounded-lg px-3 py-2">
            <span className="text-muted-foreground w-24 shrink-0 text-xs">{e.label}</span>
            <code className="mono-data min-w-0 flex-1 truncate text-xs">{e.url}</code>
            <CopyButton value={e.url} />
          </div>
        ))}
        <p className="text-muted-foreground text-xs">
          Path-style: point any S3 client at the origin (e.g. <code>aws --endpoint-url</code>) and use
          bucket <code className="mono-data">{v.bucket}</code>. Uploading with a recent AWS CLI/SDK over
          HTTPS? Set <code className="mono-data">AWS_REQUEST_CHECKSUM_CALCULATION=when_required</code>{' '}
          — the storage engine doesn’t accept their newer default upload checksums yet. Presigned
          links and downloads need nothing.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-0 flex-1 basis-56 gap-1.5">
          <span className="mono-label text-muted-foreground">
            Public S3 domain{v.publicDomainCustom ? '' : ' (default)'}
          </span>
          <Input
            value={domainDraft ?? v.publicDomain ?? ''}
            onChange={(e) => setDomainDraft(e.target.value)}
            placeholder="s3.example.com"
            className="mono-data"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button
          variant="outline"
          disabled={setDomain.isPending || domainDraft === null || domainDraft.trim() === (v.publicDomain ?? '')}
          onClick={() => setDomain.mutate({ domain: domainDraft?.trim() ? domainDraft.trim() : null })}
        >
          Save domain
        </Button>
        {v.publicDomainCustom ? (
          <Button variant="ghost" disabled={setDomain.isPending} onClick={() => setDomain.mutate({ domain: null })}>
            Use default
          </Button>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        Shared by every public bucket. Its DNS must point at your edge nodes; the certificate is issued
        automatically.
      </p>
    </section>
  );
}
