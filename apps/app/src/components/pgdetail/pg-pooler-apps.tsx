import * as React from 'react';
import type { DbPoolerView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { shortName } from './pg-topology';
import type { PgPoolerData } from './use-pg-pooler';

/**
 * Which way each wired app reaches the database, and the switch between the
 * two (`db.inject` with `via`): its DATABASE_URL then names the pooler, or the
 * main copy again. Either way the URL is a Docker secret; the app redeploys.
 */
export function PgPoolerApps({ v, p }: { v: DbPoolerView; p: PgPoolerData }): React.JSX.Element | null {
  if (v.apps.length === 0) {
    return <p className="text-muted-foreground text-[13px]">No app is wired to this database yet, so nothing goes through the pooler.</p>;
  }
  const on = v.declared !== null;
  return (
    <div className="flex flex-col">
      {v.apps.map((a) => {
        const pooled = a.via === 'pooler';
        const busy = p.moving === a.service;
        return (
          <div key={a.service} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13.5px]">
                <b className="font-semibold">{shortName(a.service)}</b>{' '}
                <span className="text-muted-foreground">{pooled ? 'goes through the pooler' : 'connects directly'}</span>
              </span>
              <Tech>
                {a.envVar} → {pooled ? v.address : `${v.writer ?? 'the main copy'}:5432`} · a Docker secret, never a label
              </Tech>
            </div>
            {pooled || on ? (
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 sm:min-h-8"
                disabled={busy || p.moving !== null}
                onClick={() => p.connect(a, pooled ? 'direct' : 'pooler')}
              >
                {busy ? 'Redeploying…' : pooled ? 'Connect directly' : 'Send through the pooler'}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
