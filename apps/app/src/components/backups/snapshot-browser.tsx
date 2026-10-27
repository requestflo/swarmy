import * as React from 'react';
import { FileIcon, FolderIcon, Link2Icon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { ErrorState, TextSkeleton } from '@/components/states';
import { folderCrumbs, sizeWords, type DownloadPick } from './download-words';

export interface BrowseEntry {
  path: string;
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  sizeBytes: string | null;
}

interface SnapshotBrowserProps {
  volumeName: string;
  dir: string;
  onDir: (path: string) => void;
  data: { entries: BrowseEntry[]; truncated: boolean; node: { type: string } | null } | undefined;
  error: unknown;
  loading: boolean;
  retry: () => void;
  pick: DownloadPick | null;
  onPick: (pick: DownloadPick) => void;
}

const ICON = { dir: FolderIcon, file: FileIcon, symlink: Link2Icon, other: FileIcon } as const;

/** One folder of a save: crumbs back up, folders to open, files to pick. */
export function SnapshotBrowser({ volumeName, dir, onDir, data, error, loading, retry, pick, onPick }: SnapshotBrowserProps): React.JSX.Element {
  const crumbs = folderCrumbs(dir, volumeName);
  return (
    <div className="flex flex-col gap-2">
      <nav aria-label="Folder in this save" className="flex flex-wrap items-center gap-1 font-mono text-[12px]">
        {crumbs.map((c, i) => (
          <React.Fragment key={c.path}>
            {i > 0 ? <span className="text-muted-foreground">/</span> : null}
            <button
              type="button"
              onClick={() => onDir(c.path)}
              aria-current={i === crumbs.length - 1 ? 'location' : undefined}
              className={cn('rounded px-1 hover:underline pointer-coarse:min-h-11', i === crumbs.length - 1 ? 'font-semibold' : 'text-muted-foreground')}
            >
              {c.name}
            </button>
          </React.Fragment>
        ))}
      </nav>
      <div className="calm-card max-h-80 overflow-y-auto p-1">
        {error ? (
          <ErrorState title="Couldn’t look inside this save." error={error} retry={retry} className="border-0" />
        ) : loading || !data ? (
          <div className="flex flex-col gap-2 p-3">
            <TextSkeleton className="h-4 w-2/3" />
            <TextSkeleton className="h-4 w-1/2" />
            <TextSkeleton className="h-4 w-3/5" />
          </div>
        ) : !data.node ? (
          <p className="text-muted-foreground p-3 text-sm">This save has nothing at {dir || 'the top'}.</p>
        ) : data.entries.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">This folder was empty when it was saved.</p>
        ) : (
          <ul aria-label="Files and folders" className="flex flex-col">
            {data.entries.map((e) => {
              const Icon = ICON[e.type];
              const usable = e.type === 'file' || e.type === 'dir';
              const picked = pick?.path === e.path;
              return (
                <li key={e.path}>
                  <button
                    type="button"
                    disabled={!usable}
                    aria-pressed={e.type === 'file' ? picked : undefined}
                    onClick={() => (e.type === 'dir' ? onDir(e.path) : onPick({ path: e.path, type: 'file', sizeBytes: e.sizeBytes }))}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm min-h-9 pointer-coarse:min-h-11',
                      picked ? 'bg-accent font-semibold' : 'hover:bg-accent/60',
                      !usable && 'text-muted-foreground cursor-not-allowed',
                    )}
                  >
                    <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    <span className="text-muted-foreground font-mono text-[11.5px]">
                      {e.type === 'dir' ? 'open' : e.type === 'file' ? sizeWords(e.sizeBytes) : 'link'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {data?.truncated ? (
        <p className="text-muted-foreground text-xs">Showing the first {data.entries.length}. Type a path below to reach the rest.</p>
      ) : null}
    </div>
  );
}
