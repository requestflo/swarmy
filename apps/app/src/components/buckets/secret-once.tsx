import * as React from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

export interface MintedKey {
  accessKeyId: string;
  /** Returned once by `buckets.createKey`; never stored, never listed again. */
  secretAccessKey: string;
  name: string;
}

/** "Copy now. This secret is never shown again." — the new key as env lines, Copy all, I've stored it. */
export function SecretOnce({ minted, endpoint, bucket, onDone }: { minted: MintedKey; endpoint: string | null; bucket: string; onDone: () => void }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const lines = [
    ['AWS_ACCESS_KEY_ID', minted.accessKeyId],
    ['AWS_SECRET_ACCESS_KEY', minted.secretAccessKey],
    ['S3_ENDPOINT', endpoint ?? 'http://swarmy-garage:3900'],
    ['S3_BUCKET', bucket],
  ] as const;
  const text = lines.map(([k, v]) => `${k}=${v}`).join('\n');
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    });
  };
  return (
    <div role="alert" className="calm-next flex flex-col gap-2.5 px-4 py-3.5">
      <p className="flex items-center gap-2 text-[14px] font-bold">
        <span aria-hidden className="bg-primary size-2 rounded-full motion-safe:animate-pulse" />
        Copy now. This secret is never shown again.
      </p>
      <pre className="calm-code overflow-x-auto px-3 py-2.5 text-[12px] select-all">{text}</pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? 'Copied' : 'Copy all'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          I’ve stored it
        </Button>
        <span className="text-muted-foreground ml-auto text-xs">Lost it? Revoke and make a new one.</span>
      </div>
    </div>
  );
}
