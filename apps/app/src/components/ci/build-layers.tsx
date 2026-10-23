import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import type { BuildLayer } from './build-log-parse';

function outcome(l: BuildLayer, live: boolean): { word: string; className: string } {
  if (l.status === 'cached') return { word: 'CACHED', className: 'text-tone-ok' };
  if (l.status === 'done') return { word: `${l.seconds ?? 0} s`, className: 'text-muted-foreground' };
  if (l.status === 'error') return { word: 'failed', className: 'text-tone-bad' };
  if (l.status === 'canceled') return { word: 'canceled', className: 'text-muted-foreground' };
  return live ? { word: 'running', className: 'text-tone-info' } : { word: '—', className: 'text-muted-foreground' };
}

/** The image's layers as BuildKit reported them: which came from cache, which ran and for how long. */
export function BuildLayers({ layers, live }: { layers: BuildLayer[]; live: boolean }): React.JSX.Element | null {
  if (layers.length === 0) return null;
  const cached = layers.filter((l) => l.status === 'cached').length;
  return (
    <Section title="Layers" hint={`${cached} of ${layers.length} from cache`}>
      <ul className="grid min-w-0 gap-1.5 font-mono text-[11.5px] [font-variant-ligatures:none]" aria-label="Build layers">
        {layers.map((l) => {
          const o = outcome(l, live);
          return (
            <li key={l.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
              <span className="truncate" title={l.instruction}>
                <Depth at="controls">
                  <span className="text-muted-foreground">[{l.stage}] </span>
                </Depth>
                {l.instruction}
              </span>
              <span className={cn('shrink-0', o.className)}>{o.word}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
