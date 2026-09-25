import * as React from 'react';
import { CalmRow, RowList, Section, Tech, type Tone } from '@/components/calm';
import type { PrivateNetwork } from './use-private-network';

const PEER: Record<string, { tone: Tone; word: string; say: string }> = {
  CONNECTED: { tone: 'mesh', word: 'Online', say: 'Connected, encrypted end to end' },
  ENROLLED: { tone: 'info', word: 'Joining', say: 'Joined, finding a direct path' },
  ENROLLING: { tone: 'info', word: 'Joining', say: 'Swapping keys with the network' },
  DEGRADED: { tone: 'warn', word: 'Needs you', say: 'Connected through a relay, slower than direct' },
  FAILED: { tone: 'bad', word: 'Offline', say: 'Could not join' },
};

/** Servers on the private network, one flat row each. */
export function ServerRows({ n }: { n: PrivateNetwork }): React.JSX.Element {
  const name = (id: string): string => n.nodes.find((x) => x.id === id)?.name ?? id;
  return (
    <Section title="Servers" count={`${n.peers.length} of ${n.nodes.length}`} flush>
      <RowList label="Servers on the private network">
        {n.peers.map((p) => {
          const s = PEER[p.status] ?? { tone: 'idle' as Tone, word: 'Idle', say: p.status.toLowerCase() };
          return (
            <CalmRow
              key={p.id}
              tone={s.tone}
              name={name(p.nodeId)}
              say={s.say}
              tech={`${p.meshIp ?? 'no address yet'} · ${p.status}`}
              word={s.word}
              wordTone={s.tone === 'mesh' ? 'ok' : s.tone}
              to="/nodes/$id"
              params={{ id: p.nodeId }}
            />
          );
        })}
        {n.missing.map((m) => (
          <CalmRow key={m.id} tone="idle" name={m.name} say="Not on the private network" word="Idle" to="/nodes/$id" params={{ id: m.id }} />
        ))}
      </RowList>
    </Section>
  );
}

/** People's laptops and phones — who is connected and what each can reach. */
export function PeopleRows({ n }: { n: PrivateNetwork }): React.JSX.Element {
  return (
    <Section title="Connected people" hint="admins see everyone" flush>
      {n.people.length === 0 ? (
        <p className="text-muted-foreground pb-3 text-[13px]">
          No laptops yet. Anyone with access can connect from an app&apos;s Access tab.
        </p>
      ) : (
        <RowList label="People on the private network">
          {n.people.map((p) => (
            <CalmRow
              key={p.peerId}
              tone={p.connected ? 'mesh' : 'idle'}
              name={p.device}
              sub={p.name}
              say={
                <span className="flex flex-col">
                  {p.stacks.length ? `Reaches ${p.stacks.join(', ')}` : 'Reaches nothing yet'}
                  <Tech>{`${p.meshIp}${p.os ? ` · ${p.os}` : ''}`}</Tech>
                </span>
              }
              word={p.connected ? 'Online' : p.loginExpired ? 'Signed out' : 'Asleep'}
              wordTone={p.connected ? 'ok' : 'idle'}
            />
          ))}
        </RowList>
      )}
    </Section>
  );
}
