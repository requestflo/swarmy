import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, CopyButton, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { BucketAccessView } from './use-bucket-reach';

/**
 * Controls under the reach switch: every address the bucket answers on, the
 * S3 client hint, and the shared public S3 domain PUBLIC needs.
 */
export function BucketEndpoints({ access: v }: { access: BucketAccessView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<string | null>(null);
  const setDomain = useMutation(
    trpc.buckets.setPublicDomain.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.domain ? `Public S3 domain set to ${r.domain}` : 'Public S3 domain reset to the default');
        setDraft(null);
        void qc.invalidateQueries({ queryKey: trpc.buckets.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const endpoints = [
    ...(v.endpoints.public ? [{ label: 'Internet', url: v.endpoints.public }] : []),
    ...v.endpoints.mesh.map((url) => ({ label: 'Private network', url })),
    { label: 'Inside swarmy', url: v.endpoints.internal },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {endpoints.map((e) => (
          <div key={e.url} className="bg-background flex items-center gap-2 rounded-lg border px-3 py-1.5">
            <span className="text-muted-foreground w-24 shrink-0 text-xs">{e.label}</span>
            <code className="mono-data min-w-0 flex-1 truncate text-xs">{e.url}</code>
            <CopyButton value={e.url} />
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Path-style: point any S3 client at the origin (<code>aws --endpoint-url</code>) and use bucket{' '}
        <code className="mono-data">{v.bucket}</code>. A recent AWS CLI/SDK uploading over HTTPS needs{' '}
        <code className="mono-data">AWS_REQUEST_CHECKSUM_CALCULATION=when_required</code>; presigned links and downloads need nothing.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 basis-48 gap-1.5">
          <span className="mono-label text-muted-foreground">Public S3 domain{v.publicDomainCustom ? '' : ' (default)'}</span>
          <Input
            value={draft ?? v.publicDomain ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="s3.example.com"
            className="mono-data"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Button
          variant="outline"
          disabled={setDomain.isPending || draft === null || draft.trim() === (v.publicDomain ?? '')}
          onClick={() => setDomain.mutate({ domain: draft?.trim() ? draft.trim() : null })}
        >
          Save domain
        </Button>
        {v.publicDomainCustom ? (
          <Button variant="ghost" disabled={setDomain.isPending} onClick={() => setDomain.mutate({ domain: null })}>
            Use default
          </Button>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">Shared by every public bucket. Its DNS must point at your edge servers; the certificate is issued automatically.</p>
    </div>
  );
}
