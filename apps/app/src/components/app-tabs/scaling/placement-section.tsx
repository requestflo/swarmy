import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { CalmRow, Section } from '@/components/calm';
import { shortName } from '../use-stack-services';
import { pinnedServer, whereWords } from './scaling-model';
import type { PlacedService } from './use-app-placement';

/** One row per part: where its copies may run (board AppPlacement), the raw rules at Controls. */
export function PlacementSection({ stack, rows, nodes }: { stack: string; rows: PlacedService[]; nodes: NodeSummary[] }): React.JSX.Element {
  return (
    <Section title="Where each part runs" count={rows.length} flush>
      <div className="flex flex-col">
        {rows.map(({ inv, detail }) => {
          const pin = pinnedServer(detail, nodes);
          const rules = detail?.constraints ?? [];
          return (
            <CalmRow
              key={inv.id}
              tone={inv.replicas.desired === 0 ? 'idle' : 'ok'}
              name={shortName(stack, inv.name)}
              say={`${whereWords(detail, nodes)}${inv.replicas.desired > 1 && !pin ? ', spread out so one server can stop' : ''}.`}
              tech={rules.join(' · ') || `${inv.mode} · no placement rules`}
              word={pin ? 'Pinned' : rules.length ? 'Ruled' : 'Anywhere'}
              wordTone={pin ? 'info' : 'idle'}
            />
          );
        })}
      </div>
    </Section>
  );
}
