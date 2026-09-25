import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Say, SayHeader, type Tone } from '@/components/calm';
import { plural } from '@/components/apps/app-words';
import type { AppItem } from '@/components/apps/use-apps';
import { TextSkeleton } from '@/components/states';
import { StackTabStrip } from './stack-tab-strip';

const CLAUSE: Record<Tone, { text: string; tone: Tone | null }> = {
  ok: { text: 'is online.', tone: null },
  warn: { text: 'needs you.', tone: 'warn' },
  bad: { text: 'is down.', tone: 'bad' },
  info: { text: 'is deploying.', tone: 'info' },
  idle: { text: 'is idle.', tone: null },
  mesh: { text: 'is private.', tone: null },
};

/** "storefront is online. 10 copies across 4 parts." — from the live stats. */
function Title({ app }: { app: AppItem }): React.JSX.Element {
  const c = CLAUSE[app.words.tone];
  const second =
    app.words.tone === 'ok'
      ? `${plural(app.stat.running, 'copy', 'copies')} across ${plural(app.stat.serviceCount, 'part')}.`
      : app.words.say.replace(/^Deploying\. /, '');
  return (
    <>
      {app.name} {c.tone ? <Say tone={c.tone}>{c.text}</Say> : c.text} <em>{second}</em>
    </>
  );
}

/**
 * The one header every app tab shares: eyebrow (App · address), the sentence
 * headline and two quiet actions, then the tab strip. Identical on every tab,
 * so nothing jumps when you switch. The sentence waits for the inventory.
 */
export function StackHeader({ stack, app }: { stack: string; app: AppItem | undefined }): React.JSX.Element {
  const system = app?.stat.system ?? false;
  const host = app?.host ?? null;
  return (
    <header className="flex flex-col gap-5">
      <SayHeader
        eyebrow={system ? 'Platform · managed by swarmy' : host ? `App · ${host}` : 'App'}
        size="md"
        title={app ? <Title app={app} /> : <TextSkeleton className="h-8 w-80 max-w-full" />}
        actions={
          system ? undefined : (
            <>
              {host ? (
                <Button asChild variant="outline">
                  <a href={`https://${host}`} target="_blank" rel="noreferrer">
                    Open the site <ArrowUpRightIcon aria-hidden className="size-4" />
                  </a>
                </Button>
              ) : null}
              <Button asChild variant="outline">
                <Link to="/stacks/$name/releases" params={{ name: stack }}>
                  Deploy a change
                </Link>
              </Button>
            </>
          )
        }
      />
      <StackTabStrip stack={stack} />
    </header>
  );
}
