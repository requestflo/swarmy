import * as React from 'react';
import { CalmRow, RowList, Section, type Tone } from '@/components/calm';
import { stateOf, type PeerState } from './mesh-graph-model';
import { seenAgo } from './mesh-format';
import type { PrivateNetwork } from './use-private-network';

const STATE: Record<PeerState, { tone: Tone; say: string; word: string; wordTone: Tone }> = {
  direct: { tone: 'mesh', say: 'Direct', word: 'Online', wordTone: 'ok' },
  relayed: { tone: 'mesh', say: 'Through a relay', word: 'Online', wordTone: 'ok' },
  unknown: { tone: 'mesh', say: 'Connected', word: 'Online', wordTone: 'ok' },
  joining: { tone: 'info', say: 'Joining', word: 'Joining', wordTone: 'info' },
  trouble: { tone: 'warn', say: "Can't connect", word: 'Needs you', wordTone: 'warn' },
};

const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`;

/**
 * Board 43's peer list: every server and laptop on the private network, how
 * it links and when it was last heard from (the agent's last report, or the
 * control plane's last-seen when the agent is quiet).
 */
export function MeshPeersSection({ n, nat }: { n: PrivateNetwork; nat: Set<string> }): React.JSX.Element {
  const name = (id: string): string => n.nodes.find((x) => x.id === id)?.name ?? id;
  return (
    <Section
      title="Peers"
      count={`${plural(n.peers.length, 'server')}${n.managed ? ` · ${plural(n.people.length, 'laptop')}` : ''}`}
      hint="last heard from"
      flush
    >
      {n.peers.length === 0 && n.people.length === 0 ? (
        <p className="text-muted-foreground pb-3 text-[13px]">Nothing on the private network yet. Servers join when you add them.</p>
      ) : (
        <RowList label="Peers on the private network">
          {n.peers.map((p) => {
            const s = STATE[stateOf(p)];
            const seen = seenAgo(p.lastSeen);
            return (
              <CalmRow
                key={p.id}
                tone={s.tone}
                name={name(p.nodeId)}
                sub={p.meshIp ?? undefined}
                say={[s.say, nat.has(p.nodeId) ? 'behind NAT' : null, seen ? `seen ${seen}` : null].filter(Boolean).join(' · ')}
                tech={`${p.status}${p.relayed === null ? '' : p.relayed ? ' · relayed' : ' · p2p'}${p.lastSeen ? ` · lastSeen ${p.lastSeen}` : ''}`}
                word={s.word}
                wordTone={s.wordTone}
                to="/nodes/$nodeId"
                params={{ nodeId: p.nodeId }}
              />
            );
          })}
          {n.people.map((p) => {
            const seen = seenAgo(p.lastSeen);
            return (
              <CalmRow
                key={p.peerId}
                tone={p.connected ? 'mesh' : 'idle'}
                name={p.device}
                sub={p.meshIp}
                say={[p.name || p.email, p.stacks.length ? `reaches ${p.stacks.join(', ')}` : 'reaches nothing yet', !p.connected && seen ? `seen ${seen}` : null]
                  .filter(Boolean)
                  .join(' · ')}
                tech={`laptop${p.os ? ` · ${p.os}` : ''}${p.version ? ` · netbird ${p.version}` : ''}`}
                word={p.connected ? 'Online' : p.loginExpired ? 'Signed out' : 'Asleep'}
                wordTone={p.connected ? 'ok' : 'idle'}
              />
            );
          })}
        </RowList>
      )}
    </Section>
  );
}
