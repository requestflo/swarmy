import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton } from '@/components/states';
import type { StudioScope, StudioTableView } from './studio-types';

/** Columns (name, type, nullable, default, key) and indexes of one table / collection. */
export function StudioStructure({ scope, table }: { scope: StudioScope; table: StudioTableView }): React.JSX.Element {
  const trpc = useTRPC();
  const mongo = scope.target.engine === 'mongo';
  const coll = useQuery({ ...trpc.studio.collection.queryOptions({ stack: scope.stack, target: scope.target.name, database: scope.database, collection: table.name }), enabled: mongo });
  if (mongo && coll.isPending) return <CardSkeleton />;
  const t = mongo ? (coll.data ?? table) : table;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
      <div className="card-pop overflow-hidden border-0">
        <div className="bg-muted grid grid-cols-[1.2fr_1fr_5rem_1fr] gap-3 px-3 py-2 text-xs font-semibold">
          <span>{mongo ? 'field' : 'column'}</span><span>type</span><span>null</span><span>default</span>
        </div>
        {t.columns.map((c) => (
          <div key={c.name} className="border-border grid grid-cols-[1.2fr_1fr_5rem_1fr] gap-3 border-t px-3 py-2 font-mono text-xs">
            <span className="flex items-center gap-1.5 truncate">{c.key ? <KeyRoundIcon className="text-primary size-3" /> : null}{c.name}</span>
            <span className="text-status-progress truncate">{c.type}</span>
            <span className="text-muted-foreground">{c.nullable ? 'yes' : 'no'}</span>
            <span className="text-muted-foreground truncate">{c.default ?? ''}</span>
          </div>
        ))}
        {mongo && 'sampled' in t ? <p className="text-muted-foreground border-border border-t px-3 py-2 text-xs">Inferred from {String((t as { sampled: number }).sampled)} sampled documents.</p> : null}
      </div>
      <div className="card-pop overflow-hidden border-0">
        <div className="bg-muted px-3 py-2 text-xs font-semibold">Indexes</div>
        {t.indexes.length === 0 ? <p className="text-muted-foreground px-3 py-3 text-xs">No indexes.</p> : null}
        {t.indexes.map((i) => (
          <div key={i.name} className="border-border space-y-0.5 border-t px-3 py-2">
            <p className="flex items-center gap-2 font-mono text-xs font-semibold">
              {i.name}
              {i.primary ? <span className="bg-primary/12 text-primary rounded-full px-1.5 text-[10px]">primary</span> : i.unique ? <span className="bg-muted rounded-full px-1.5 text-[10px]">unique</span> : null}
            </p>
            <p className="text-muted-foreground truncate font-mono text-[11px]">{i.definition ?? i.columns.join(', ')}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
