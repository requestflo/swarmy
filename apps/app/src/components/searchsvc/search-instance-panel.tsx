import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import {
  CopyButton,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusBadge,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { bytes } from '@/lib/format';
import { instanceTone } from './search-instance-card';
import { DestroySearchDialog } from './destroy-search-dialog';
import { SearchAttachSection } from './search-attach-section';
import { SearchBackupsSection } from './search-backups-section';

/**
 * Instance detail panel: endpoint + key secret, live stats (docs, indexes,
 * size/memory), attached apps, snapshots and the danger zone. Opens from a
 * card on the Search page.
 */
export function SearchInstancePanel({
  stack,
  name,
  onOpenChange,
}: {
  stack: string | null;
  name: string | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const open = Boolean(stack && name);
  const ref = { stack: stack ?? '', name: name ?? '' };

  const detail = useQuery({
    ...trpc.search.get.queryOptions(ref),
    enabled: open,
    refetchInterval: 4_000,
  });
  const liveStats = useQuery({
    ...trpc.search.stats.queryOptions(ref),
    enabled: open,
    refetchInterval: 5_000,
    retry: false,
  });

  const view = detail.data ?? null;
  const stats = liveStats.data ?? view?.stats ?? null;
  const tone = view ? instanceTone(view) : null;
  const size = stats?.dbSizeBytes ?? stats?.memoryBytes ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-border border-b p-6">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
              <SearchIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="truncate">{name ?? 'Search'}</SheetTitle>
              <SheetDescription className="mono-label !mb-0">
                {view ? view.engine : '…'} · {stack}
              </SheetDescription>
            </div>
            {tone ? <StatusBadge tone={tone.tone} label={tone.label} className="ml-auto shrink-0" /> : null}
          </div>
        </SheetHeader>

        {!view ? (
          <div className="space-y-3 p-6">
            <div className="shimmer-line h-10 rounded-lg" />
            <div className="shimmer-line h-24 rounded-lg" />
            <div className="shimmer-line h-24 rounded-lg" />
          </div>
        ) : (
          <div className="space-y-6 p-6">
            <section className="space-y-2">
              <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
                <code className="mono-data truncate text-xs">{view.url}</code>
                <CopyButton value={view.url} />
              </div>
              <p className="text-muted-foreground text-[11px]">
                Private-only — reachable on the instance network. The master key was shown once
                at provision and lives in the Docker secret{' '}
                <code className="mono-data">{view.keySecret}</code>; attached apps read it from
                the secret file.
              </p>
            </section>

            <section className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['Documents', stats?.docs],
                    [view.engine === 'typesense' ? 'Collections' : 'Indexes', stats?.indexes],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">{label}</p>
                    <p className="mono-data text-sm">
                      {typeof value === 'number' ? <CountUp value={value} /> : '—'}
                    </p>
                  </div>
                ))}
                <div>
                  <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">
                    {view.engine === 'typesense' ? 'Memory' : 'DB size'}
                  </p>
                  <p className="mono-data text-sm">{size !== null ? bytes(size) : '—'}</p>
                </div>
              </div>
              {stats ? (
                <p className="text-muted-foreground text-[11px]">
                  Sampled {new Date(stats.at).toLocaleTimeString()}
                </p>
              ) : (
                <p className="text-muted-foreground text-[11px]">Awaiting first stats sample.</p>
              )}
            </section>

            <SearchAttachSection view={view} />
            <SearchBackupsSection view={view} />

            <section className="space-y-2">
              <p className="mono-label text-muted-foreground !mb-0">Danger zone</p>
              <DestroySearchDialog view={view} onDestroyed={() => onOpenChange(false)} />
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
