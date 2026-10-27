import * as React from 'react';
import { DownloadIcon } from 'lucide-react';
import { DEFAULT_DOWNLOAD_MAX_BYTES } from '@swarmy/core';
import { Button, Input, Label, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, cn } from '@swarmy/ui';
import { TONE_TEXT, Tech } from '@/components/calm';
import { volumeWords } from './backup-words';
import { pickWords, statusWords, type DownloadPick } from './download-words';
import { SnapshotBrowser } from './snapshot-browser';
import { useSnapshotDownload } from './use-snapshot-download';

interface DownloadSnapshotSheetProps {
  snapshotId: string;
  volume: string;
  disabled?: boolean;
}

function actionLabel(pick: DownloadPick): string {
  if (pick.type === 'file') return 'Download this file';
  if (pick.type === 'typed') return 'Download this path';
  return pick.path ? 'Download this folder' : 'Download the whole volume';
}

/**
 * "Download a file or folder…" on a save (board 16): look inside it, pick a
 * file or a folder (or type a path), and download it as a .tar.gz. Nothing
 * in the live app changes. The size shows up front for a file; a folder's
 * shows as it downloads, and the dialog says how it went.
 */
export function DownloadSnapshotSheet({ snapshotId, volume, disabled }: DownloadSnapshotSheetProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const d = useSnapshotDownload(snapshotId, open);
  const data = d.browse.data;
  const maxBytes = data?.maxBytes ?? String(DEFAULT_DOWNLOAD_MAX_BYTES);
  const pick: DownloadPick = d.pick ?? { path: d.dir, type: 'dir', sizeBytes: null };
  const words = pickWords(pick, maxBytes);
  const status = d.started && !d.demo ? statusWords(d.status, d.started.fileName) : null;
  const busy = d.ticket.isPending || (!!d.status && (d.status.state === 'ready' || d.status.state === 'streaming'));

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) d.reset();
      }}
    >
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 pointer-coarse:min-h-11"
        disabled={disabled}
        aria-label="Download a file or folder…"
        title="Download a file or folder…"
        onClick={() => setOpen(true)}
      >
        <DownloadIcon className="size-4" /> Download…
      </Button>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <span className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">Download · from a save</span>
          <SheetTitle>Download from {volumeWords(volume)}</SheetTitle>
          <SheetDescription>Pick a file or folder as it was saved. It downloads as a .tar.gz, and nothing in the live app changes.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-8">
          <SnapshotBrowser
            volumeName={volume}
            dir={d.dir}
            onDir={d.setDir}
            data={data}
            error={d.browse.error}
            loading={d.browse.isPending}
            retry={() => void d.browse.refetch()}
            pick={d.pick}
            onPick={d.setPick}
          />
          <form
            className="grid gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) d.setPick({ path: typed.trim().replace(/^\/+|\/+$/g, ''), type: 'typed', sizeBytes: null });
            }}
          >
            <Label htmlFor={`dl-path-${snapshotId}`}>Or type a path in the volume</Label>
            <div className="flex gap-2">
              <Input id={`dl-path-${snapshotId}`} value={typed} placeholder="config/app.yml" onChange={(e) => setTyped(e.target.value)} className="font-mono" />
              <Button type="submit" variant="outline" disabled={!typed.trim()} className="pointer-coarse:min-h-11">
                Pick
              </Button>
            </div>
          </form>
          <p className={cn('text-[13px] break-words', TONE_TEXT[words.tone])}>{words.text}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!words.ok || busy} onClick={() => d.download(pick)} className="pointer-coarse:min-h-11">
              <DownloadIcon className="size-4" /> {d.ticket.isPending ? 'Getting it ready…' : actionLabel(pick)}
            </Button>
          </div>
          <div role="status" aria-live="polite" className="flex flex-col gap-1 text-[13px]">
            {d.ticket.isError ? <span className="text-tone-bad">{d.ticket.error.message}</span> : null}
            {status ? <span className={TONE_TEXT[status.tone]}>{status.text}</span> : null}
            {d.demo && d.started ? (
              <span className="text-muted-foreground">
                This is a demo, so nothing downloads. On your own controller this saves {d.started.fileName}, streamed from the server that holds the save.
              </span>
            ) : null}
          </div>
          <Tech>
            backups.downloadTicket · snapshot {snapshotId.slice(0, 8)} · /data{pick.path ? `/${pick.path}` : ''} → GET /api/backups/download?ticket=… (one use, 30 s)
          </Tech>
        </div>
      </SheetContent>
    </Sheet>
  );
}
