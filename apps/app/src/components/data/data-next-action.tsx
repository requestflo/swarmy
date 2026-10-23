import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { DataItem } from './estate-data';

/** The least-protected thing the apps keep, and the one thing to do about it. */
export function DataNextAction({ worst: w }: { worst: DataItem }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const run = useMutation(
    trpc.dbBackups.run.mutationOptions({
      onSuccess: () => {
        toast.success('Saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <NextAction
      tone={w.tone}
      title={`${w.app} / ${w.name}: ${w.say.replace(/\.$/, '')}`}
      tech={w.tech}
      actions={
        w.kind === 'Postgres' && w.cluster ? (
          <>
            <Button disabled={run.isPending} onClick={() => run.mutate({ stack: w.app, cluster: w.cluster! })}>
              {run.isPending ? 'Saving…' : 'Save it now'}
            </Button>
            <Button variant="outline" asChild>
              <Link to="/stacks/$name/data" params={{ name: w.app }}>Set up nightly saves</Link>
            </Button>
          </>
        ) : w.kind === 'Bucket' ? (
          <Button asChild>
            <Link to="/data/buckets/$name" params={{ name: w.name }}>Open it</Link>
          </Button>
        ) : (
          <Button asChild>
            <Link to="/stacks/$name/data" params={{ name: w.app }}>Open it</Link>
          </Button>
        )
      }
    >
      This is the least-protected thing you keep. A save now takes a minute and doesn’t stop the app.
    </NextAction>
  );
}
