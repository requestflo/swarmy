import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { StatusTone } from '@swarmy/ui';
import { CalmRow, RowList, Section, toneFromStatus } from '@/components/calm';

/** The container fields this list renders (subset of the agent container view). */
export interface NodeContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

const STATE_TONE: Record<string, StatusTone> = {
  created: 'neutral',
  running: 'online',
  paused: 'warning',
  restarting: 'progress',
  removing: 'warning',
  exited: 'offline',
  dead: 'offline',
};

interface NodeContainersPanelProps {
  containers: NodeContainer[] | undefined;
}

/** Everything running on this host — a flat hairline list, never per-row cards. */
export function NodeContainersPanel({ containers }: NodeContainersPanelProps): React.JSX.Element {
  const rows = containers ?? [];
  return (
    <Section title="Running here" count={containers ? rows.length : undefined} flush>
      {containers === undefined ? (
        <span className="shimmer-line my-3 block h-10 rounded-lg" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">
          Nothing runs here yet.{' '}
          <Link to="/deploy" className="text-primary font-semibold hover:underline">
            Deploy an app
          </Link>{' '}
          and swarmy places it on a server with room.
        </p>
      ) : (
        <RowList label="Containers on this server">
          {rows.map((c) => {
            const tone = toneFromStatus(STATE_TONE[c.state] ?? 'neutral');
            return (
              <CalmRow
                key={c.id}
                tone={tone}
                name={c.name.replace(/^\//, '')}
                sub={c.image}
                say={c.status}
                word={c.state}
                wordTone={tone}
              />
            );
          })}
        </RowList>
      )}
    </Section>
  );
}
