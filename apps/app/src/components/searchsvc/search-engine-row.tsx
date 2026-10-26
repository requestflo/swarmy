import * as React from 'react';
import type { SearchInstanceView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { Kv } from './search-kv';
import { engineSwitch } from './search-switch-words';

const LABEL = { meilisearch: 'Meilisearch', typesense: 'Typesense' } as const;
const short = (svc: string): string => svc.replace(/^[^_]*_/, '');

/**
 * The Engine row (board 41): which engine, where its copy runs, and — one
 * switch away — what moving to the other engine would take. swarmy doesn't
 * switch engines: it's a data migration and a change to the app's own search
 * code, so the row says so instead of offering a button that can't keep its
 * promise.
 */
export function SearchEngineRow({ v, where }: { v: SearchInstanceView; where: string | null }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const s = engineSwitch(v.engine, v.attachments[0] ? short(v.attachments[0].service) : null);
  return (
    <Kv
      k="Engine"
      tech={`swarmy.search.engine=${v.engine} · fixed when it was made`}
      action={
        <Depth at="controls">
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Close' : `Switch to ${s.to}?`}
          </Button>
        </Depth>
      }
    >
      <span className="text-[13px]">
        {LABEL[v.engine]}
        {where ? `, one copy on ${where}` : ''} <span className="text-muted-foreground">· switching to {s.to} makes a new index</span>
      </span>
      {open ? (
        <div className="bg-muted/50 mt-1 flex flex-col gap-2 rounded-lg px-3 py-2.5" aria-label={`What switching to ${s.to} takes`}>
          <ol className="flex flex-col gap-1.5">
            {s.steps.map((x, k) => (
              <li key={x.head} className="grid grid-cols-[1.25rem_minmax(0,1fr)] text-[12.5px]">
                <span className="text-muted-foreground font-mono">{k + 1}</span>
                <span>
                  <b className="font-semibold">{x.head}.</b> <span className="text-muted-foreground">{x.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-[12.5px]">{s.move}</p>
        </div>
      ) : null}
    </Kv>
  );
}
