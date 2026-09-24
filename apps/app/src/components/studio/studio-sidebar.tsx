import * as React from 'react';
import { TableIcon } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@swarmy/ui';
import { ENGINE_BADGE, isKvEngine, type StudioSchemaView, type StudioTableView, type StudioTargetView } from './studio-types';

interface StudioSidebarProps {
  targets: StudioTargetView[];
  current: StudioTargetView;
  onPick: (name: string) => void;
  schema: StudioSchemaView | undefined;
  database: string | null;
  onDatabase: (db: string) => void;
  dbIndex: number;
  onDbIndex: (i: number) => void;
  table: StudioTableView | null;
  onTable: (t: StudioTableView) => void;
}

const fmt = (n: number | null) => (n == null ? '' : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());

/** Databases of the app, then the open database's tables / collections / keyspaces. */
export function StudioSidebar(p: StudioSidebarProps): React.JSX.Element {
  const kv = isKvEngine(p.current.engine);
  const tables = p.schema?.tables ?? [];
  return (
    <aside className="border-border flex w-full shrink-0 flex-col gap-1 border-b p-3 lg:w-60 lg:border-r lg:border-b-0" aria-label="Databases">
      <span className="mono-label text-muted-foreground px-2 pb-1">Databases</span>
      {p.targets.map((t) => (
        <button
          key={t.name}
          type="button"
          aria-pressed={t.name === p.current.name}
          onClick={() => p.onPick(t.name)}
          className={cn('flex h-10 w-full items-center gap-2.5 rounded-xl border border-transparent px-2.5 text-left', t.name === p.current.name ? 'bg-muted border-primary/40' : 'hover:bg-accent/60')}
        >
          <span className="bg-muted text-status-progress inline-flex size-6 shrink-0 items-center justify-center rounded-lg font-mono text-[9.5px] font-bold">{ENGINE_BADGE[t.engine]}</span>
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] font-semibold">{t.name}</span>
            <span className="text-muted-foreground block truncate font-mono text-[10.5px]">{t.engine}{t.kind === 'managed' ? ' · managed' : ''}{t.production ? ' · prod' : ''}</span>
          </span>
        </button>
      ))}
      <div className="bg-border my-2 h-px" />
      {kv ? (
        <>
          <span className="mono-label text-muted-foreground px-2 pb-1">Keyspaces</span>
          {(p.schema?.keyspaces?.length ? p.schema.keyspaces : [{ index: 0, keys: 0 }]).map((k) => (
            <button key={k.index} type="button" onClick={() => p.onDbIndex(k.index)} className={cn('flex h-7 items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px]', p.dbIndex === k.index ? 'bg-muted font-semibold' : 'text-muted-foreground hover:text-foreground')}>
              db{k.index}<span className="text-muted-foreground ml-auto font-mono text-[10.5px]">{fmt(k.keys)}</span>
            </button>
          ))}
        </>
      ) : (
        <>
          {p.schema && p.schema.databases.length > 1 ? (
            <Select value={p.database ?? p.schema.database ?? ''} onValueChange={p.onDatabase}>
              <SelectTrigger className="mb-1 h-8 text-xs"><SelectValue placeholder="database" /></SelectTrigger>
              <SelectContent>{p.schema.databases.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
            </Select>
          ) : null}
          <span className="mono-label text-muted-foreground px-2 pb-1">{p.current.engine === 'mongo' ? 'Collections' : 'Tables'}</span>
          <div className="max-h-72 overflow-auto lg:max-h-none lg:flex-1">
            {tables.map((t) => (
              <button
                key={`${t.schema ?? ''}.${t.name}`}
                type="button"
                onClick={() => p.onTable(t)}
                className={cn('flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px]', p.table?.name === t.name && p.table?.schema === t.schema ? 'bg-muted font-semibold' : 'text-muted-foreground hover:text-foreground')}
              >
                <TableIcon className="size-3 shrink-0" />
                <span className="truncate">{t.schema && t.schema !== 'public' ? `${t.schema}.` : ''}{t.name}</span>
                <span className="ml-auto font-mono text-[10.5px]">{fmt(t.rowsEstimate)}</span>
              </button>
            ))}
            {p.schema && tables.length === 0 ? <p className="text-muted-foreground px-2.5 text-xs">No tables yet — create one from the console.</p> : null}
          </div>
        </>
      )}
      <div className="bg-muted/60 mt-2 rounded-xl p-3 text-[11.5px]">
        <p className="flex items-center gap-1.5 font-semibold"><span className="pulse-dot" /> via the agent on the DB’s server</p>
        <p className="text-muted-foreground mt-1 leading-snug">Never a public port. Row limit 1000 · timeout 15 s · every query audited.</p>
      </div>
    </aside>
  );
}
