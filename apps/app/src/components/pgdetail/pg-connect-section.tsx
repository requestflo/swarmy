import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button, CopyButton } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { PgRotatePassword } from './pg-rotate-password';
import { shortName } from './pg-topology';
import type { PgDetailData } from './use-pg-detail';

function Row({ k, v, note, copy }: { k: string; v: string; note: string; copy?: boolean }): React.JSX.Element {
  return (
    <div className="border-border flex min-h-11 items-center gap-2 border-b py-2 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[12px] font-semibold">{k}</span>
          <span className="text-muted-foreground text-[11.5px]">{note}</span>
        </span>
        <code className="text-muted-foreground truncate font-mono text-[12px]">{v}</code>
      </div>
      {copy ? <CopyButton value={v} aria-label={`Copy ${k} host`} className="size-9 shrink-0" /> : null}
    </div>
  );
}

/**
 * Connect (board 39): the two variables swarmy injects, which of the app's
 * services get them (`stacks.endpoints`), where the password lives, and
 * Rotate password. Private network only, so there's no address from outside.
 */
export function PgConnectSection({ stack, d }: { stack: string; d: PgDetailData }): React.JSX.Element {
  const c = d.cluster!;
  const apps = (d.attached ?? []).map(shortName);
  const hint = d.attached === null ? undefined : apps.length ? `wired into ${apps.join(', ')}` : 'no app is wired to it yet';
  return (
    <Section title="Connect" hint={hint}>
      <div className="flex flex-col">
        <Row k="DATABASE_URL" v={`${c.rwHost}:5432`} note="reads and writes" copy />
        <Row k="DATABASE_RO_URL" v={`${c.roHost}:5432`} note="reads, from the standby copies" copy />
        <Row k="Password" v="••••••••••••" note="in a Docker secret" />
      </div>
      <Tech>
        password secret mounted as a file · revealing it is audited (db.password.reveal) · private network only, no published port
      </Tech>
      {c.fileDelivered?.map((a) => (
        <Tech key={a.service}>
          {shortName(a.service)} has no shell, so it reads {a.envVar}_FILE instead of {a.envVar}
        </Tech>
      ))}
      <div className="flex flex-wrap gap-2">
        <PgRotatePassword stack={stack} cluster={c.name} apps={apps} />
        <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-8">
          <Link to="/network/connections" search={{ app: stack }}>
            Who can reach it
          </Link>
        </Button>
      </div>
    </Section>
  );
}
