import * as React from 'react';
import { CalmRow, RowList, Section, type Tone } from '@/components/calm';
import { linkSplit } from './mesh-facts';
import type { PrivateNetwork } from './use-private-network';

const PEER: Record<string, { tone: Tone; word: string; say: string }> = {
  CONNECTED: { tone: 'mesh', word: 'Online', say: 'Connected, encrypted end to end' },
  ENROLLED: { tone: 'info', word: 'Joining', say: 'Joined, finding a direct path' },
  ENROLLING: { tone: 'info', word: 'Joining', say: 'Swapping keys with the network' },
  DEGRADED: { tone: 'warn', word: 'Needs you', say: 'Connected through a relay, slower than direct' },
  FAILED: { tone: 'bad', word: 'Offline', say: 'Could not join' },
};

/** How a connected server's links go: peer to peer, or through a relay (null = not reported yet). */
const LINK = {
  direct: 'Direct, peer to peer, no middleman',
  relayed: 'Through a relay, still end-to-end encrypted',
};

/** "2 direct · 1 relayed" over the connected servers that reported it; null when none has. */
export function linkCounts(peers: PrivateNetwork['peers']): string | null {
  const split = linkSplit(peers);
  return split ? `${split.direct} direct · ${split.relayed} relayed` : null;
}

/** Servers on the private network, one flat row each. */
export function ServerRows({ n }: { n: PrivateNetwork }): React.JSX.Element {
  const name = (id: string): string => n.nodes.find((x) => x.id === id)?.name ?? id;
  const links = linkCounts(n.peers);
  return (
    <Section title="Servers" count={`${n.peers.length} of ${n.nodes.length}`} hint={links ?? undefined} flush>
      <RowList label="Servers on the private network">
        {n.peers.map((p) => {
          const s = PEER[p.status] ?? { tone: 'idle' as Tone, word: 'Idle', say: p.status.toLowerCase() };
          const link = p.status === 'CONNECTED' && p.relayed !== null ? (p.relayed ? 'relayed' : 'direct') : null;
          return (
            <CalmRow
              key={p.id}
              tone={s.tone}
              name={name(p.nodeId)}
              say={link ? LINK[link] : s.say}
              tech={`${p.meshIp ?? 'no address yet'} · ${p.status}${link ? ` · ${link}` : ''}`}
              word={s.word}
              wordTone={s.tone === 'mesh' ? 'ok' : s.tone}
              to="/nodes/$nodeId"
              params={{ nodeId: p.nodeId }}
            />
          );
        })}
        {n.missing.map((m) => (
          <CalmRow key={m.id} tone="idle" name={m.name} say="Not on the private network" word="Idle" to="/nodes/$nodeId" params={{ nodeId: m.id }} />
        ))}
      </RowList>
    </Section>
  );
}
