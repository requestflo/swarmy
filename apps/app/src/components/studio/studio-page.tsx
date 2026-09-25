import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseIcon, LockIcon, LockOpenIcon } from 'lucide-react';
import { Button, EmptyState, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState, PageSkeleton } from '@/components/states';
import { StudioSidebar } from './studio-sidebar';
import { StudioData } from './studio-data';
import { StudioStructure } from './studio-structure';
import { StudioKeys } from './studio-keys';
import { StudioConsole } from './studio-console';
import { StudioSaved } from './studio-saved';
import { StudioInsights } from './studio-insights';
import { Depth, SayHeader } from '@/components/calm';
import { StudioSummary } from './studio-summary';
import { StudioCode } from './studio-code';
import { isKvEngine, type StudioScope, type StudioTab, type StudioTableView } from './studio-types';

const TABS: Array<[StudioTab | 'structure', string]> = [['data', 'Data'], ['structure', 'Structure'], ['console', 'Console'], ['saved', 'Saved queries'], ['insights', 'Slow queries']];

/** Database studio for one app: pick a database, browse / edit / query / profile it. */
export function StudioPage({ stack, db, onDb }: { stack: string; db?: string; onDb: (name: string) => void }): React.JSX.Element {
  const trpc = useTRPC();
  const targets = useQuery(trpc.studio.targets.queryOptions({ stack }));
  const current = targets.data?.find((t) => t.name === db) ?? targets.data?.find((t) => !t.unavailable) ?? targets.data?.[0];
  const [tab, setTab] = React.useState<StudioTab | 'structure'>('data');
  const [unlocked, setUnlocked] = React.useState(false);
  const [database, setDatabase] = React.useState<string | null>(null);
  const [dbIndex, setDbIndex] = React.useState(0);
  const [table, setTable] = React.useState<StudioTableView | null>(null);
  const [draft, setDraft] = React.useState('');
  React.useEffect(() => { setDatabase(null); setTable(null); setDbIndex(0); setUnlocked(false); }, [current?.name]);

  const usable = Boolean(current && !current.unavailable && current.running);
  const schema = useQuery({ ...trpc.studio.schema.queryOptions({ stack, target: current?.name ?? '', database }), enabled: usable });
  const tables = schema.data?.tables;
  React.useEffect(() => { if (tables && (!table || !tables.some((t) => t.name === table.name && t.schema === table.schema))) setTable(tables[0] ?? null); }, [tables, table]);

  if (targets.isPending) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;
  if (targets.isError) return <ErrorState error={targets.error} retry={() => void targets.refetch()} />;
  if (!current) return <EmptyState icon={<DatabaseIcon />} title="No databases in this app yet" description="Add managed Postgres on the Data tab, or deploy MySQL, MariaDB, Postgres, Mongo, Redis or Valkey in the compose file — they show up here." />;

  const scope: StudioScope = { stack, target: current, database: database ?? schema.data?.database ?? null, dbIndex, unlocked };
  const kv = isKvEngine(current.engine);
  const openInConsole = (s: string) => { setDraft(s); setTab('console'); };

  const box = (
    <div className="calm-card flex min-h-[40rem] flex-col overflow-hidden lg:flex-row">
      <StudioSidebar targets={targets.data} current={current} onPick={onDb} schema={schema.data} database={scope.database} onDatabase={setDatabase} dbIndex={dbIndex} onDbIndex={setDbIndex} table={table} onTable={(t) => { setTable(t); if (tab !== 'structure') setTab('data'); }} />
      <section className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-display text-xl font-bold">{kv ? 'Keys' : (table?.name ?? current.name)}</h2>
          <span className="text-muted-foreground font-mono text-xs">{current.name} · {current.engine}{schema.data?.version ? ` ${schema.data.version.split(/[ -]/)[0]}` : ''}</span>
          <div className="flex-1" />
          <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs', unlocked ? 'bg-status-warning/15 text-tone-warn' : 'bg-muted text-muted-foreground')}>
            {unlocked ? <LockOpenIcon className="size-3" /> : <LockIcon className="size-3" />}
            {unlocked ? 'Writes unlocked — each one is confirmed and audited' : 'Read-only · writes need data.write'}
          </span>
          <Button size="sm" variant="outline" onClick={() => setUnlocked(!unlocked)}>{unlocked ? 'Back to read-only' : 'Unlock writes'}</Button>
        </div>
        <div role="tablist" aria-label="Studio views" className="bg-muted flex w-fit flex-wrap gap-1 rounded-full p-1">
          {TABS.filter(([k]) => !(kv && k === 'structure')).map(([k, label]) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('min-h-9 rounded-full px-3 py-1 text-xs font-semibold pointer-coarse:min-h-11', tab === k ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {kv && k === 'data' ? 'Keys' : label}
            </button>
          ))}
        </div>
        {current.unavailable ? <ErrorState title="The studio can’t sign in to this database." error={current.unavailable} /> : !current.running ? <ErrorState title="No running task" error={`${current.name} isn't running on any online server.`} /> : (
          <StudioTabBody tab={tab} scope={scope} table={table} schemaPending={schema.isPending} schemaError={schema.error} draft={draft} setDraft={setDraft} openInConsole={openInConsole} />
        )}
      </section>
    </div>
  );
  const nTables = schema.data?.tables.length;
  return (
    <div className="flex flex-col gap-5">
      <SayHeader
        size="md"
        title={
          <>
            {current.name} {kv ? 'holds' : 'has'} {kv ? 'keys' : nTables === undefined ? 'tables' : `${nTables} ${nTables === 1 ? 'table' : 'tables'}`}.{' '}
            <em>{unlocked ? 'Writes are unlocked, each one confirmed.' : 'Read-only until you unlock writes.'}</em>
          </>
        }
        lede={`Browse, edit and query ${current.engine}. Every query runs through the agent on the database’s server, never a public port, and is audited.`}
      />
      <StudioCode stack={stack} target={current} table={table} />
      <Depth only="summary">
        <StudioSummary targets={targets.data} current={current} onPick={onDb} schema={schema.data} onTable={setTable} />
      </Depth>
      <Depth at="controls">{box}</Depth>
    </div>
  );
}

interface BodyProps { tab: StudioTab | 'structure'; scope: StudioScope; table: StudioTableView | null; schemaPending: boolean; schemaError: unknown; draft: string; setDraft: (s: string) => void; openInConsole: (s: string) => void }

function StudioTabBody({ tab, scope, table, schemaPending, schemaError, draft, setDraft, openInConsole }: BodyProps): React.JSX.Element {
  if (tab === 'console') return <StudioConsole scope={scope} draft={draft} onDraft={setDraft} />;
  if (tab === 'saved') return <StudioSaved scope={scope} onEdit={openInConsole} />;
  if (tab === 'insights') return <StudioInsights scope={scope} onOpen={openInConsole} />;
  if (isKvEngine(scope.target.engine)) return <StudioKeys scope={scope} />;
  if (schemaError) return <ErrorState error={schemaError} />;
  if (schemaPending) return <CardSkeleton />;
  if (!table) return <EmptyState title="No tables yet" description="Create one from the console — unlock writes first." />;
  return tab === 'structure' ? <StudioStructure scope={scope} table={table} /> : <StudioData scope={scope} table={table} />;
}
