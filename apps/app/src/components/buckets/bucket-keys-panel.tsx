import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { LockIcon, PlusIcon } from 'lucide-react';
import type { BucketDetailView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { shortName } from './attach-plan';
import { permWord } from './bucket-facts';
import { GrantKeyInline } from './grant-key-inline';
import { NewBucketKey } from './new-bucket-key';
import { RevokeKeyButton } from './revoke-key-button';
import { SecretOnce, type MintedKey } from './secret-once';

/** Access keys on this bucket: each app gets its own; a new key's secret is shown once. */
export function BucketKeysPanel({ bucket: b, endpoint }: { bucket: BucketDetailView; endpoint: string | null }): React.JSX.Element {
  const trpc = useTRPC();
  const [adding, setAdding] = React.useState(false);
  const [granting, setGranting] = React.useState(false);
  const [minted, setMinted] = React.useState<MintedKey | null>(null);
  const all = useQuery(trpc.buckets.listKeys.queryOptions());
  const platform = new Set((all.data?.keys ?? []).filter((k) => k.platform).map((k) => k.id));
  const usedBy = new Map(b.attachments.map((a) => [a.accessKeyId, `${a.stack} / ${shortName(a.stack, a.service)}`]));

  return (
    <Section
      title="Access keys"
      hint="each app gets its own key · the secret is shown once"
      action={
        <Button size="sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
          <PlusIcon className="size-4" /> New key
        </Button>
      }
    >
      {adding ? <NewBucketKey bucket={b} onMinted={(k) => { setMinted(k); setAdding(false); }} onCancel={() => setAdding(false)} /> : null}
      {minted ? <SecretOnce minted={minted} endpoint={endpoint} bucket={b.name} onDone={() => setMinted(null)} /> : null}
      {b.keys.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">No key can reach this bucket yet. Attach an app, or make a key for a tool.</p>
      ) : (
        <ul className="flex flex-col">
          {b.keys.map((k) => (
            <li key={k.accessKeyId} className="border-border flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[13px] font-semibold">{k.name || k.accessKeyId}</span>
                <span className="text-muted-foreground block truncate font-mono text-[11px]">
                  {k.accessKeyId}
                  {usedBy.has(k.accessKeyId) ? ` · used by ${usedBy.get(k.accessKeyId)}` : ''}
                </span>
              </span>
              <span className="bg-muted rounded-full px-2 py-0.5 text-[11px] font-semibold">{permWord(k.permissions)}</span>
              {platform.has(k.accessKeyId) ? (
                <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs" title="swarmy manages this key and replaces it itself.">
                  <LockIcon className="size-3.5" /> Used by swarmy
                </span>
              ) : (
                <RevokeKeyButton bucket={b} accessKeyId={k.accessKeyId} name={k.name} usedBy={usedBy.get(k.accessKeyId)} />
              )}
            </li>
          ))}
        </ul>
      )}
      <Depth at="controls">
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setGranting((v) => !v)}>
            Give an existing key access
          </Button>
          <GrantKeyInline bucketId={b.id} open={granting} onDone={() => setGranting(false)} />
        </div>
      </Depth>
    </Section>
  );
}
