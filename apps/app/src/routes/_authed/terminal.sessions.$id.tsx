import * as React from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle, Card, CardContent } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { AsciinemaPlayer } from '@/components/terminal/asciinema-player';

export const Route = createFileRoute('/_authed/terminal/sessions/$id')({
  component: SessionReplayPage,
});

/** Replay a recorded terminal session (asciicast). RBAC enforced server-side. */
function SessionReplayPage(): React.JSX.Element {
  const trpc = useTRPC();
  const { id } = useParams({ from: '/_authed/terminal/sessions/$id' });

  const session = useQuery(trpc.terminal.get.queryOptions({ id }));
  const recording = useQuery(trpc.terminal.recording.get.queryOptions({ id }));

  const s = session.data;
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Session replay"
        title={
          <>
            {s?.targetKind === 'nodeShell' ? 'Node shell' : 'Container exec'}{' '}
            <em>{s ? new Date(s.startedAt).toLocaleString() : ''}</em>
          </>
        }
        description={
          s
            ? `${s.bytesIn} bytes in · ${s.bytesOut} bytes out · ${s.reason ?? 'open'}`
            : 'Loading session…'
        }
      />

      {recording.isError && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>No recording</AlertTitle>
          <AlertDescription>
            This session has no recording, or you don’t have access to it.
          </AlertDescription>
        </Alert>
      )}

      <Card className="card-pop border-0">
        <CardContent className="p-3">
          {recording.data?.cast ? (
            <AsciinemaPlayer cast={recording.data.cast} />
          ) : (
            <div className="text-muted-foreground p-16 text-center text-sm">
              {recording.isLoading ? 'Loading recording…' : 'No recording available.'}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
