import * as React from 'react';
import { Button } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { GraphList } from './graph-list';
import type { Graph, GraphDiff } from './graph-model';
import { GraphSvg } from './graph-svg';
import { ToneChip } from './tone-chip';

const n = (k: string, g: Graph): number => g.nodes.filter((x) => x.kind === k).length;
const many = (c: number, one: string, more: string): string => `${c} ${c === 1 ? one : more}`;

/** "4 services, 4 resources, 2 addresses and 3 jobs". */
export function graphWords(g: Graph): string {
  const parts = [
    many(n('service', g), 'service', 'services'),
    many(n('resource', g), 'resource', 'resources'),
    many(n('domain', g), 'address', 'addresses'),
    many(n('job', g), 'job', 'jobs'),
  ].filter((p) => !p.startsWith('0 '));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'nothing yet');
}

/**
 * "Live graph · what this file builds" (board YamlEditor): app-config's
 * toDesired of the text in the editor, redrawn as you type, with what the
 * edit adds, removes and changes against the saved file, and Undo edits.
 */
export function LiveGraph({ graph, diff, dirty, old, onUndo }: { graph: Graph | null; diff: GraphDiff | null; dirty: boolean; old: boolean; onUndo: () => void }): React.JSX.Element {
  return (
    <Section
      title="What this file builds"
      hint="live as you type"
      action={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {diff?.chips.map((c) => (
            <ToneChip key={c.text} tone={c.tone}>
              {c.text}
            </ToneChip>
          ))}
          {dirty ? (
            <Button type="button" size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={onUndo}>
              Undo edits
            </Button>
          ) : null}
        </div>
      }
    >
      {graph && diff ? (
        <>
          <div className="border-border bg-background/60 hidden rounded-xl border p-2 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:22px_22px] sm:block">
            <GraphSvg graph={graph} state={diff.state} label={`This file builds ${graphWords(graph)}.`} />
          </div>
          <div className="sm:hidden">
            <GraphList graph={graph} state={diff.state} removed={diff.removed} />
          </div>
          {old ? <p className="text-muted-foreground text-xs">Showing the last version that parsed. Fix the problem and it updates.</p> : null}
          {diff.removed.length ? (
            <p className="text-muted-foreground hidden text-xs sm:block">
              Removed: <span className="font-mono">{diff.removed.map((r) => r.name).join(', ')}</span>
            </p>
          ) : null}
          <Tech>toDesired(parseAppConfig(text)) · @swarmy/app-config · the same planner the controller runs on push</Tech>
        </>
      ) : (
        <p className="text-muted-foreground text-[13.5px]">Nothing to draw until the file parses. The problems are listed under the editor.</p>
      )}
    </Section>
  );
}
