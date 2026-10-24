import * as React from 'react';
import { SearchIcon } from 'lucide-react';
import type { SearchInstanceView } from '@swarmy/core';
import { CopyButton } from '@swarmy/ui';
import { Depth, StatusWord, Tech, type Tone } from '@/components/calm';
import { relativeTime } from '@/components/resilience/format';
import { serverList, useMemberServers } from '@/components/stack-data/use-member-servers';
import { bytes } from '@/lib/format';
import { DestroySearchDialog } from './destroy-search-dialog';
import { SearchAttachSection } from './search-attach-section';
import { SearchBackupsSection } from './search-backups-section';
import { SearchIndexes } from './search-indexes';
import { SearchKeyRow } from './search-key-row';
import { Kv } from './search-kv';

const ENGINE = { meilisearch: { label: 'Meilisearch', env: 'MEILI_HOST' }, typesense: { label: 'Typesense', env: 'TYPESENSE_HOST' } } as const;
const short = (svc: string): string => svc.replace(/^[^_]*_/, '');

function tone(v: SearchInstanceView): Tone {
  if (v.status === 'absent' || v.status === 'stopped' || v.status === 'failing') return 'bad';
  if (v.status === 'deploying') return 'info';
  return v.status === 'running' && v.running >= v.desired ? 'ok' : 'warn';
}

/**
 * One managed search instance as the DataStores board lays it out (board
 * 41): the engine and its variable, where its one copy runs, what it holds
 * (documents, indexes, size from the stats stamp), the master key and the
 * engine, then its indexes and their settings read from the engine itself.
 * Controls adds the address and the existing attach/saves/remove.
 */
export function SearchBlock({ v }: { v: SearchInstanceView }): React.JSX.Element {
  const servers = useMemberServers(v.service).byService?.get(v.service);
  const where = serverList(servers);
  const e = ENGINE[v.engine];
  const env = v.attachments[0]?.envVar ?? e.env;
  const s = v.stats;
  const size = s?.dbSizeBytes ?? s?.memoryBytes ?? null;
  const apps = v.attachments.map((a) => short(a.service));
  return (
    <article aria-label={`The ${v.name} search`} className="flex flex-col gap-3 py-4 first:pt-2">
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span aria-hidden className="bg-status-online/15 text-tone-ok flex size-7 items-center justify-center rounded-lg">
          <SearchIcon className="size-3.5" />
        </span>
        <h3 className="font-display text-[15.5px] font-bold">{v.name}</h3>
        <span className="text-muted-foreground font-mono text-[11.5px]">
          {e.label} · {env}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span className="bg-muted rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold">{where ? `one copy · ${where}` : 'one copy'}</span>
          <StatusWord tone={tone(v)} />
        </span>
      </header>
      <div className="bg-muted/60 flex flex-col gap-1 rounded-xl px-3.5 py-3">
        <span className="text-[13.5px]">
          {s ? (
            <>
              <b className="font-semibold">{s.docs.toLocaleString()} documents</b> in {s.indexes} {s.indexes === 1 ? 'index' : 'indexes'}
              {size !== null ? <span className="text-muted-foreground"> · {bytes(size)}</span> : null}
            </>
          ) : (
            'Not counted yet'
          )}
        </span>
        <span className="text-muted-foreground text-[12.5px]">
          {apps.length ? `Searched by ${apps.join(', ')}` : 'No app uses it yet'}
          {s ? ` · counted ${relativeTime(s.at)}` : ''}
        </span>
        {s ? <Tech>{v.engine === 'typesense' ? 'memory' : 'database size'} from swarmy.search.stats · sampled {new Date(s.at).toLocaleTimeString()}</Tech> : null}
      </div>
      <SearchIndexes v={v} />
      <div className="flex flex-col">
        <SearchKeyRow v={v} />
        <Kv k="Engine" tech={`swarmy.search.engine=${v.engine} · fixed when it was made`}>
          <span className="text-[13px]">{e.label}{where ? `, one copy on ${where}` : ''}</span>
        </Kv>
      </div>
      <Depth at="controls">
        <div className="border-border flex flex-col gap-5 border-t pt-4">
          <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-1.5">
            <code className="truncate font-mono text-xs">{v.url}</code>
            <CopyButton value={v.url} aria-label="Copy the search address" className="size-9" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <SearchAttachSection view={v} />
            <SearchBackupsSection view={v} />
          </div>
          <DestroySearchDialog view={v} onDestroyed={() => undefined} />
        </div>
      </Depth>
    </article>
  );
}
