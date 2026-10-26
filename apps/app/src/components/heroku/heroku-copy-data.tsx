import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { herokuCopyPhrase, type HerokuImportSource } from '@swarmy/core';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { Section, StatusWord, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { HerokuCopyResult } from './heroku-types';

const TONE = { copied: 'ok', 'copied-with-errors': 'warn', 'not-empty': 'warn', failed: 'bad' } as const;
const WORD = { copied: 'Copied', 'copied-with-errors': 'Copied, with errors', 'not-empty': 'Not copied', failed: 'Failed' } as const;

/**
 * The data, as its own explicit step after Deploy: a one-shot copy of a
 * Heroku Postgres into the new, empty managed one. You type
 * `<app>/<database>` to run it; Heroku is only read, and a database that
 * already has tables is left alone.
 */
export function HerokuCopyData({ source, stack, cluster, envVar }: { source: HerokuImportSource; stack: string; cluster: string; envVar?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const phrase = herokuCopyPhrase(stack, cluster);
  const [typed, setTyped] = React.useState('');
  const [result, setResult] = React.useState<HerokuCopyResult | null>(null);
  const copy = useMutation(
    trpc.herokuImport.copyDatabase.mutationOptions({
      onSuccess: (r) => {
        setResult(r);
        if (r.status === 'copied') toast.success(r.say);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const id = `heroku-copy-${cluster}`;
  return (
    <Section title={`Copy ${cluster}’s data from Heroku`} hint="once, when you’re ready">
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">
        swarmy reads Heroku’s database through {envVar ?? 'its URL'} and loads it into {cluster}, which must still be
        empty. Heroku keeps running and nothing there changes. Anything written on Heroku after the copy stays there, so copy just
        before you switch over.
      </p>
      {result ? (
        <div role="status" className="flex flex-col gap-1">
          <StatusWord tone={TONE[result.status]} word={WORD[result.status]} />
          <span className="text-[13.5px]">{result.say}</span>
        </div>
      ) : null}
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed === phrase && !copy.isPending) copy.mutate({ source, stack, cluster, confirm: typed });
        }}
      >
        <Label htmlFor={id} className="text-[13px]">
          Type <span className="font-mono font-semibold">{phrase}</span> to copy
        </Label>
        <div className="flex flex-wrap gap-2">
          <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={phrase} autoComplete="off" spellCheck={false} className="max-w-xs font-mono" />
          <Button type="submit" variant="outline" disabled={typed !== phrase || copy.isPending} className="pointer-coarse:min-h-11">
            {copy.isPending ? 'Copying… this page waits' : 'Copy the data'}
          </Button>
        </div>
      </form>
      <Tech>pg_dump -Fc (TLS) | pg_restore --no-owner into an empty database · one-shot on the database’s server</Tech>
    </Section>
  );
}
