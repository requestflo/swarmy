import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link2Icon } from 'lucide-react';
import type { BucketDetailView } from '@swarmy/core';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '900', label: '15 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '86400', label: '24 hours' },
  { value: '604800', label: '7 days' },
];

/**
 * Presigned URLs: mint a time-limited share (GET) or upload (PUT) link for one
 * object — no access key ever leaves the controller.
 */
export function BucketPresignSection({ bucket }: { bucket: BucketDetailView }): React.JSX.Element {
  const trpc = useTRPC();
  const [key, setKey] = React.useState('');
  const [method, setMethod] = React.useState<'GET' | 'PUT'>('GET');
  const [expires, setExpires] = React.useState('3600');

  const presign = useMutation(
    trpc.buckets.presignUrl.mutationOptions({
      onSuccess: (r) => {
        void navigator.clipboard.writeText(r.url);
        toast.success(
          `Presigned ${r.method} URL copied — valid until ${new Date(r.expiresAt).toLocaleString()}`,
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">Presigned URLs</p>
      <p className="text-muted-foreground text-xs">
        Time-limited link for a single object — share a download or accept one upload without
        handing out a key.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-0 flex-1 basis-48 gap-1.5">
          <Label className="mono-label">Object key</Label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="exports/report.pdf"
            className="mono-data"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Action</Label>
          <Select value={method} onValueChange={(v) => setMethod(v === 'PUT' ? 'PUT' : 'GET')}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GET">Download (GET)</SelectItem>
              <SelectItem value="PUT">Upload (PUT)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Expires</Label>
          <Select value={expires} onValueChange={setExpires}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          disabled={presign.isPending || key.trim().length === 0}
          onClick={() =>
            presign.mutate({
              bucketId: bucket.id,
              key: key.trim(),
              method,
              expiresSeconds: Number.parseInt(expires, 10),
            })
          }
        >
          <Link2Icon className="size-4" />
          {presign.isPending ? 'Signing…' : 'Copy presigned URL'}
        </Button>
      </div>
    </section>
  );
}
