import * as React from 'react';
import { ArrowUpRightIcon } from 'lucide-react';
import { Say, SayHeader, type Tone } from '@/components/calm';
import { plural } from '@/components/apps/app-words';
import type { AppItem } from '@/components/apps/use-apps';
import { TextSkeleton } from '@/components/states';
import { AppHeaderActions } from './app-header-actions';
import { AppHeaderMeta } from './app-header-meta';
import { StackTabStrip } from './stack-tab-strip';
import { useAppHeaderFacts } from './use-app-header-facts';

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

/** "App · shop.northwind.dev ↗": the address opens the site. */
function Eyebrow({ host }: { host: string | null }): React.JSX.Element {
  if (!host) return <>App</>;
  return (
    <>
      App ·{' '}
      <a
        href={`https://${host}`}
        target="_blank"
        rel="noreferrer"
        className="hover:text-foreground inline-flex items-center gap-1 pointer-coarse:-my-3.5 pointer-coarse:py-3.5"
      >
        {host} <ArrowUpRightIcon aria-hidden className="size-3" />
        <span className="sr-only">(opens the site)</span>
      </a>
    </>
  );
}

/**
 * The one header every app tab shares (as on every app board): the address,
 * the sentence, then a quiet line — environment · managed by swarmy.yaml @
 * branch · sha · newest release and its age — with Rewind and Redeploy, then
 * the tab strip. Identical on every tab, so nothing jumps when you switch.
 * The sentence waits for the inventory; each fact waits for its own read.
 */
export function StackHeader({ stack, app }: { stack: string; app: AppItem | undefined }): React.JSX.Element {
  const system = app?.stat.system ?? false;
  const facts = useAppHeaderFacts(stack);
  return (
    <header className="flex flex-col gap-5">
      <SayHeader
        eyebrow={system ? 'Platform · managed by swarmy' : <Eyebrow host={app?.host ?? null} />}
        size="md"
        title={app ? <Title app={app} /> : <TextSkeleton className="h-8 w-80 max-w-full" />}
        lede={!system && (facts.env || facts.git || facts.release) ? <AppHeaderMeta facts={facts} /> : undefined}
        actions={system ? undefined : <AppHeaderActions stack={stack} stackId={facts.stackId} />}
      />
      <StackTabStrip stack={stack} />
    </header>
  );
}
