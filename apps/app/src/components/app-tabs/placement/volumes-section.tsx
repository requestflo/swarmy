import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { NodeSummary } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { CalmRow, Section } from '@/components/calm';
import { fmtBytes } from '@/components/buckets/format';
import { RowsSkeleton } from '../tab-body';
import type { PlacedService } from '../scaling/use-app-placement';
import { MakeDurable } from './make-durable';
import { useAppBuckets } from './use-app-buckets';
import { volumeRows, type VolumeRow } from './volume-model';

const and = (xs: string[]): string => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * Volumes (board AppPlacement): data on disk stays on its server, buckets
 * replicate instead. Pinned data moves with "Move…" (the Servers move flow),
 * a bucket opens its page, a throwaway volume can be made durable.
 */
export function VolumesSection({ stack, rows, nodes }: { stack: string; rows: PlacedService[]; nodes: NodeSummary[] }): React.JSX.Element {
  const vols = React.useMemo(() => volumeRows(stack, rows, nodes), [stack, rows, nodes]);
  const { buckets, copies, servers } = useAppBuckets(stack);
  const [durable, setDurable] = React.useState<string | null>(null);
  const count = vols.length + (buckets?.length ?? 0);
  return (
    <Section title="Volumes" count={buckets ? count : undefined} hint="data on disk stays on its server; buckets replicate instead" flush>
      {buckets === undefined ? (
        <RowsSkeleton rows={2} />
      ) : count === 0 ? (
        <p className="text-muted-foreground px-1 py-3 text-[13.5px]">Nothing here keeps files. Every copy starts clean, so any server can run it.</p>
      ) : (
        <div className="flex flex-col">
          {vols.map((v) => (
            <React.Fragment key={v.key}>
              <VolumeLine v={v} onDurable={() => setDurable(v.key)} />
              {durable === v.key ? <MakeDurable stack={stack} row={v} svc={rows.find((r) => r.inv.id === v.serviceId)!} onDone={() => setDurable(null)} /> : null}
            </React.Fragment>
          ))}
          {buckets.map(({ bucket, parts }) => (
            <CalmRow
              key={bucket.id}
              tone="ok"
              name={bucket.name}
              sub={`bucket · used by ${parts.join(', ')}`}
              say={`${fmtBytes(bucket.usageBytes)}${copies ? `, ${copies} ${copies === 1 ? 'copy' : 'copies'} of every file` : ''}${servers?.length ? ` on ${and(servers)}` : ''}: any server can read it.`}
              tech={`${bucket.objects.toLocaleString()} objects · S3_* attached to ${parts.join(', ')}`}
              word={copies && copies > 1 ? 'Replicated' : 'One copy'}
              wordTone={copies && copies > 1 ? 'ok' : 'warn'}
              trailing={<LinkButton to="/data/buckets/$name" params={{ name: bucket.name }} label="Open" />}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function VolumeLine({ v, onDurable }: { v: VolumeRow; onDurable: () => void }): React.JSX.Element {
  const ro = v.readOnly ? ':ro' : '';
  if (v.kind === 'pinned' || v.kind === 'roaming') {
    const pinned = v.kind === 'pinned';
    return (
      <CalmRow
        tone={pinned ? 'ok' : 'warn'}
        name={v.source}
        sub={`${v.part} · ${v.target}`}
        say={pinned ? `Stays on ${v.server!.name}; ${v.part} follows its data.` : `Kept on whichever server runs ${v.part}: a copy that moves starts with an empty one.`}
        tech={`volume ${v.source}:${v.target}${ro}`}
        word={pinned ? `Pinned · ${v.server!.name}` : 'Per server'}
        wordTone={pinned ? 'info' : 'warn'}
        trailing={pinned ? <LinkButton to="/nodes" search={{ move: v.serviceId }} label="Move…" /> : undefined}
      />
    );
  }
  if (v.kind === 'host') {
    return <CalmRow tone="idle" name={`${v.part} · ${v.target}`} sub="a folder on the server" say={`Reads ${v.source} from whichever server runs ${v.part}.`} tech={`bind ${v.source}:${v.target}${ro}`} word="Host folder" wordTone="idle" />;
  }
  return (
    <CalmRow
      tone="idle"
      name={`${v.part} · ${v.target}`}
      sub={v.tmpfs ? 'in memory' : 'anonymous'}
      say={v.tmpfs ? 'Kept in memory and emptied on every restart: fine for scratch files.' : 'Emptied when a copy moves or is replaced: fine for a cache, not for anything you’d miss.'}
      tech={v.tmpfs ? `tmpfs ${v.target}` : `volume (anonymous):${v.target}`}
      word="Throwaway"
      wordTone="idle"
      trailing={v.tmpfs ? undefined : <Button size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-[12px] pointer-coarse:min-h-11" onClick={onDurable}>Make durable</Button>}
    />
  );
}

function LinkButton({ to, params, search, label }: { to: string; params?: Record<string, string>; search?: Record<string, string>; label: string }): React.JSX.Element {
  return (
    <Button asChild size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-[12px] pointer-coarse:min-h-11">
      <Link to={to} params={params as never} search={search as never}>
        {label}
      </Link>
    </Button>
  );
}
