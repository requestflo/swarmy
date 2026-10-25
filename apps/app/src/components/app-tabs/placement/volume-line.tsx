import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { CalmRow } from '@/components/calm';
import { relTime } from '@/lib/format';
import type { VolumeRow } from './volume-model';
import { volumeSay, type VolumeSize } from './volume-size';

/** The mono tech line's size part: exact bytes per server and when its agent measured (Controls). */
function sizeTech(size: VolumeSize | null): string {
  if (!size) return '';
  if (size.kind === 'unreported') return ' · size not reported (agent predates volume sizes, or not measured yet)';
  const bytes = size.places.map((p) => `${p.bytes.toLocaleString('en-US')} B on ${p.server.name}`).join(', ');
  return ` · ${bytes} · docker system df -v, ${relTime(new Date(size.sampledAt))}`;
}

/**
 * One volume (board AppPlacement): a pinned one says its size and server and
 * offers Move…, a roaming one its per-server copies, a host folder and a
 * throwaway volume say what they are; a throwaway one can be made durable.
 */
export function VolumeLine({ v, size, onDurable }: { v: VolumeRow; size: VolumeSize | null; onDurable: () => void }): React.JSX.Element {
  const ro = v.readOnly ? ':ro' : '';
  if (v.kind === 'pinned' || v.kind === 'roaming') {
    const pinned = v.kind === 'pinned';
    return (
      <CalmRow
        tone={pinned ? 'ok' : 'warn'}
        name={v.source}
        sub={`${v.part} · ${v.target}`}
        say={volumeSay(v, size)}
        tech={`volume ${v.source}:${v.target}${ro}${sizeTech(size)}`}
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

export function LinkButton({ to, params, search, label }: { to: string; params?: Record<string, string>; search?: Record<string, string>; label: string }): React.JSX.Element {
  return (
    <Button asChild size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-[12px] pointer-coarse:min-h-11">
      <Link to={to} params={params as never} search={search as never}>
        {label}
      </Link>
    </Button>
  );
}
