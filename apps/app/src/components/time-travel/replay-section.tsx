import * as React from 'react';
import { Undo2Icon } from 'lucide-react';
import type { ReleaseView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';
import { RollbackConfirm } from '@/components/releases/rollback-confirm';
import { momentLabel } from './time-travel-model';
import type { Replay, ReplayPart } from './time-travel-replay';

/** "ghcr.io/northwind/storefront-web:1.8.2" → "storefront-web:1.8.2". */
const shortImage = (image: string): string => image.slice(image.lastIndexOf('/') + 1);

function PartCard({ p, live }: { p: ReplayPart; live: boolean }): React.JSX.Element {
  const note = live || !p.changed ? 'unchanged' : p.nowTag ? `${p.tag} → ${p.nowTag} since` : 'removed since';
  return (
    <li className={cn('border-border flex min-w-0 flex-col gap-1 rounded-xl border px-3.5 py-3', !live && p.changed && 'border-tone-info/50')}>
      <span className="flex items-center gap-2">
        <span aria-hidden className="bg-status-online size-2 shrink-0 rounded-full" />
        <span className="truncate text-[14px] font-semibold">{p.name}</span>
      </span>
      <span className="truncate font-mono text-[12px]">{shortImage(p.image)}</span>
      <span className={cn('font-mono text-[11px]', !live && p.changed ? 'text-tone-info' : 'text-muted-foreground')}>{note}</span>
      <Tech className="truncate">{p.image}</Tech>
    </li>
  );
}

interface ReplaySectionProps {
  stack: string;
  at: number;
  live: boolean;
  replay: Replay;
  /** Today's release, to tell whether putting the one at T back would change anything. */
  head: ReleaseView | undefined;
  firstAt: number | null;
}

/**
 * "<app> as it was at T": each part with the image it ran then, read-only.
 * When that version differs from today's, Put back vN redeploys it (code
 * only; the data is not touched) through the existing confirm.
 */
export function ReplaySection({ stack, at, live, replay, head, firstAt }: ReplaySectionProps): React.JSX.Element {
  const { release, parts, later } = replay;
  const label = releaseLabel(release ?? undefined);
  const differs = Boolean(release && head && release.id !== head.id && parts.some((p) => p.changed));
  return (
    <Section
      title={live ? `${stack} right now` : `${stack} as it was at ${momentLabel(at)}`}
      hint={live ? 'what runs' : 'read-only replay'}
      action={
        !live && release && differs ? (
          <RollbackConfirm
            release={release}
            label={label}
            trigger={
              <Button variant="outline" size="sm" className="pointer-coarse:min-h-11">
                <Undo2Icon className="size-4" /> Put back {label}
              </Button>
            }
          />
        ) : undefined
      }
    >
      {release ? (
        <>
          <p className="text-muted-foreground text-[13.5px]">
            {live ? `Running ${label}.` : `Running ${label}${differs ? '. Putting it back redeploys these images; your data is not touched.' : ', the same as now.'}`}
          </p>
          <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
            {parts.map((p) => (
              <PartCard key={p.name} p={p} live={live} />
            ))}
            {later.map((p) => (
              <li key={p.name} className="border-border flex flex-col gap-1 rounded-xl border border-dashed px-3.5 py-3 opacity-70">
                <span className="truncate text-[14px] font-semibold">{p.name}</span>
                <span className="text-muted-foreground font-mono text-[11px]">
                  not there yet{Number.isFinite(p.at) ? ` · arrives with ${p.label}, ${momentLabel(p.at)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <Tech>releases.list · release {release.id} · {release.images.length} images</Tech>
        </>
      ) : (
        <p className="text-muted-foreground text-[13.5px]">
          {firstAt
            ? `No version on record this early. swarmy has every deploy of ${stack} from ${momentLabel(firstAt)} on.`
            : `${stack} has no deploys on record yet. Every deploy from now on can be replayed here.`}
        </p>
      )}
    </Section>
  );
}
