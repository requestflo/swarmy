import * as React from 'react';
import { LockIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import type { GraphModel, GraphNode } from './creates-model';

const DOT: Record<GraphNode['kind'], string> = {
  entry: 'bg-status-online',
  app: 'bg-primary',
  data: 'bg-status-progress',
  backup: 'bg-status-online',
};

function Node({ node, details, big }: { node: GraphNode; details: 'always' | 'controls'; big?: boolean }): React.JSX.Element {
  const detail = node.detail ? (
    <span className={cn('text-muted-foreground block font-mono', big ? 'text-[11px] break-all' : 'truncate text-[10.5px]')}>{node.detail}</span>
  ) : null;
  return (
    <div
      className={cn(
        'bg-card min-w-0 rounded-lg border',
        big ? 'px-3 py-2' : 'px-2.5 py-1.5',
        node.kind === 'app' ? 'border-primary/60' : 'border-border',
      )}
    >
      <span className={cn('flex min-w-0 items-center gap-1.5 font-semibold', big ? 'text-[13.5px]' : 'text-[12.5px]')}>
        {node.kind === 'entry' ? (
          <LockIcon aria-hidden className="text-tone-ok size-3 shrink-0" />
        ) : (
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[node.kind])} />
        )}
        <span className="truncate">{node.label}</span>
      </span>
      {details === 'always' ? detail : <Depth at="controls">{detail}</Depth>}
    </div>
  );
}

function Wire(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="border-border h-3 self-center border-l border-dashed sm:h-auto sm:min-w-3 sm:flex-1 sm:self-auto sm:border-t sm:border-l-0"
    />
  );
}

/**
 * "What gets created": HTTPS → the app → its data, as three columns joined by
 * dashed wires. Read as a list by screen readers (the picture is decoration).
 */
export function CreatesGraph({
  model,
  details = 'controls',
  big,
  className,
}: {
  model: GraphModel;
  details?: 'always' | 'controls';
  big?: boolean;
  className?: string;
}): React.JSX.Element {
  const label = [model.entry?.label, model.app.label, ...model.data.map((d) => d.label)].filter(Boolean).join(', ');
  return (
    <div
      role="img"
      aria-label={`Creates: ${label}`}
      className={cn(
        'bg-background/60 flex flex-col items-stretch gap-1.5 overflow-hidden rounded-xl border sm:flex-row sm:items-center',
        big ? 'min-h-56 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px] p-5' : 'p-3.5',
        className,
      )}
    >
      {model.entry ? (
        <>
          <div className="shrink-0 sm:max-w-[34%]">
            <Node node={model.entry} details={details} big={big} />
          </div>
          <Wire />
        </>
      ) : null}
      <div className="shrink-0 sm:max-w-[36%]">
        <Node node={model.app} details={details} big={big} />
      </div>
      {model.data.length ? (
        <>
          <Wire />
          <div className="flex min-w-0 shrink-0 flex-col gap-2 sm:max-w-[40%]">
            {model.data.map((n) => (
              <Node key={n.key} node={n} details={details} big={big} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
