import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SearchInstanceView, SearchKeyRotateResult } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SecretRevealBanner } from '@/components/cache/secret-reveal-banner';
import { Kv } from './search-kv';

const short = (svc: string): string => svc.replace(/^[^_]*_/, '');

/**
 * The master key row (board 41): never shown again after it is made, with
 * Rotate — a new key in a new Docker secret version, the engine restarted on
 * it, every attached app moved onto it — and the new key shown once. The
 * confirm sits inline, never a modal.
 */
export function SearchKeyRow({ v }: { v: SearchInstanceView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const [result, setResult] = React.useState<SearchKeyRotateResult | null>(null);
  const rotate = useMutation(
    trpc.search.rotateKey.mutationOptions({
      onSuccess: (r) => {
        setResult(r);
        setConfirming(false);
        if (r.failed.length) toast.error(`${r.failed.map((f) => short(f.service)).join(', ')} still on the old key — rotate again`);
        void qc.invalidateQueries({ queryKey: trpc.search.list.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const apps = v.attachments.map((a) => short(a.service));
  const meili = v.engine === 'meilisearch';
  return (
    <>
      <Kv
        k="Master key"
        tech={`Docker secret ${v.keySecret} · mounted as a file for attached apps`}
        action={
          <Button size="sm" variant="outline" aria-expanded={confirming} disabled={rotate.isPending} onClick={() => setConfirming(!confirming)}>
            Rotate
          </Button>
        }
      >
        <span className="text-[13px]">
          <span className="font-mono">••••••••••••</span> <span className="text-muted-foreground">· shown once, when it was made</span>
        </span>
      </Kv>
      {confirming ? (
        <div className="bg-muted/60 flex flex-col gap-2 rounded-xl px-3.5 py-3" role="group" aria-label="Rotate the master key">
          <p className="!mb-0 text-[13px]">
            swarmy makes a new key and restarts {meili ? 'Meilisearch' : 'Typesense'} on it — search pauses for a few seconds.
            {apps.length ? ` Then ${apps.join(', ')} restart${apps.length === 1 ? 's' : ''} with the new key; nothing in them changes.` : ' No app uses it yet.'}
            {meili ? ' Any API key made from the old master key stops working.' : ''}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate({ stack: v.stack, name: v.name })}>
              {rotate.isPending ? 'Rotating…' : 'Rotate the key'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep this one
            </Button>
          </div>
        </div>
      ) : null}
      {result ? (
        <SecretRevealBanner
          title={`New master key for ${result.name} — shown once.`}
          description={
            <>
              Save it now — it lives only in the Docker secret <code className="mono-data">{result.keySecret}</code>.{' '}
              {result.redeployed.length > 1 ? `${result.redeployed.slice(1).map(short).join(', ')} already use it.` : ''}
            </>
          }
          secret={result.masterKey}
          onDismiss={() => setResult(null)}
        />
      ) : null}
    </>
  );
}
