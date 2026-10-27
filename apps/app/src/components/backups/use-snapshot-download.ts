import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { isDemo } from '@/demo/is-demo';
import { useTRPC } from '@/integrations/trpc';
import { isFinished, type DownloadPick } from './download-words';

/** A same-origin download: the route's Content-Disposition names the file. */
function saveFrom(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const NO_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The picker + download for one volume save: the folder being looked at
 * (`backups.browseSnapshot`), what's picked, the single-use link
 * (`backups.downloadTicket`) and how the download goes (`downloadStatus`,
 * polled until it ends — a browser download that breaks off can't say why).
 * The demo has no controller to stream from, so it mints and stops there.
 */
export function useSnapshotDownload(snapshotId: string, open: boolean) {
  const trpc = useTRPC();
  const demo = isDemo();
  const [dir, setDirState] = React.useState('');
  const [pick, setPick] = React.useState<DownloadPick | null>(null);
  const [started, setStarted] = React.useState<{ downloadId: string; fileName: string } | null>(null);

  const browse = useQuery({ ...trpc.backups.browseSnapshot.queryOptions({ snapshotId, path: dir }), enabled: open, staleTime: 60_000 });
  const ticket = useMutation(
    trpc.backups.downloadTicket.mutationOptions({
      onSuccess: (t) => {
        setStarted({ downloadId: t.downloadId, fileName: t.fileName });
        if (!demo) saveFrom(t.url, t.fileName);
      },
    }),
  );
  const status = useQuery({
    ...trpc.backups.downloadStatus.queryOptions({ downloadId: started?.downloadId ?? NO_ID }),
    enabled: !!started && !demo,
    refetchInterval: (q) => (isFinished(q.state.data) ? false : 1_000),
  });

  const setDir = (path: string): void => {
    setDirState(path);
    setPick(null);
  };
  const reset = (): void => {
    setStarted(null);
    ticket.reset();
  };
  const download = (p: DownloadPick): void => {
    reset();
    ticket.mutate({ snapshotId, path: p.path });
  };
  return { demo, dir, setDir, pick, setPick, browse, ticket, started, status: status.data ?? null, download, reset };
}
