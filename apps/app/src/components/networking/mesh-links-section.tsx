import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Section, TONE_DOT, TONE_TEXT, type Tone } from '@/components/calm';
import type { MeshPeerLike } from './mesh-graph-model';
import { endWords, latencyWords, linkPath, pairKey, type MeshLinkLike } from './mesh-link-words';

interface Row {
  id: string;
  a: string;
  b: string;
  link: MeshLinkLike | undefined;
}

const SAY: Record<'direct' | 'relayed' | 'none', { tone: Tone; word: string; say: string }> = {
  direct: { tone: 'mesh', word: 'Direct', say: 'Peer to peer' },
  relayed: { tone: 'warn', word: 'Relayed', say: 'Through the relay, still end-to-end encrypted' },
  none: { tone: 'idle', word: 'Not reported', say: 'This link’s servers haven’t reported it (an older agent, or no traffic yet)' },
};

/**
 * Every link between connected servers at Controls (board 14): its path and
 * round trip, and each end's own view with the bytes it moved. The two ends
 * measure separately, so both are shown; a link neither end reported says so.
 */
export function MeshLinksSection({
  peers,
  names,
  links,
}: {
  peers: MeshPeerLike[];
  names: Map<string, string>;
  links: MeshLinkLike[] | undefined;
}): React.JSX.Element | null {
  const on = peers.filter((p) => p.status === 'CONNECTED').map((p) => p.nodeId).sort();
  if (on.length < 2) return null;
  const byPair = new Map((links ?? []).map((l) => [pairKey(l.a, l.b), l]));
  const rows: Row[] = on.flatMap((a, i) => on.slice(i + 1).map((b) => ({ id: pairKey(a, b), a, b, link: byPair.get(pairKey(a, b)) })));
  const name = (id: string): string => names.get(id) ?? id;
  const reported = rows.filter((r) => r.link).length;
  return (
    <Section title="Links" count={`${reported} of ${rows.length} reported`} hint="each end measures its own round trip" flush>
      <ul aria-label="Links between servers" className="flex flex-col">
        {rows.map((r) => {
          const kind = r.link ? (linkPath(r.link) ?? 'direct') : 'none';
          const s = SAY[kind];
          const lat = r.link ? latencyWords(r.link) : null;
          return (
            <li key={r.id} className="border-border flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-b px-1 py-2 last:border-b-0">
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[s.tone])} />
              <span className="min-w-0 truncate text-[14px] font-semibold sm:w-44 sm:shrink-0">
                {name(r.a)} ⇄ {name(r.b)}
              </span>
              <span className="text-muted-foreground order-last min-w-0 basis-full pl-5 text-[13px] sm:order-none sm:basis-0 sm:flex-1 sm:pl-0">
                {s.say}
                {lat ? ` · ${lat}` : ''}
              </span>
              <span className={cn('ml-auto shrink-0 text-xs font-semibold sm:ml-0', TONE_TEXT[s.tone])}>{s.word}</span>
              {r.link ? (
                <span className="text-muted-foreground order-last basis-full pl-5 font-mono text-[11.5px] leading-relaxed break-words">
                  {name(r.a)} → {name(r.b)} · {endWords(r.link.a === r.a ? r.link.ab : r.link.ba)}
                  <br />
                  {name(r.b)} → {name(r.a)} · {endWords(r.link.a === r.a ? r.link.ba : r.link.ab)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
