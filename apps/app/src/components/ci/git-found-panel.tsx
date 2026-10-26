import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { TextSkeleton } from '@/components/states';
import { foundWords, GitFoundItems, hasSwarmyYaml } from './git-found-items';
import { GitFoundNeeds } from './git-found-needs';
import type { GitLink } from './use-git-link';
import type { GitWizard } from './use-git-wizard';
import { useInspectSource } from './use-inspect-source';
import type { LinkedApp } from './use-linked-apps';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * The wizard's aside (board 23): what the read found in the picked folder
 * and the one coral action, Link & scan (⌘↵). An app that already deploys
 * from this folder gets "Open <app>" instead.
 */
export function GitFoundPanel({
  w,
  l,
  appAt,
}: {
  w: GitWizard;
  l: GitLink;
  appAt: (cloneUrl: string, configPath: string) => LinkedApp | undefined;
}): React.JSX.Element {
  const found = useInspectSource(l.linked ? null : w.source);
  const path = w.configPath || 'swarmy.yaml';
  const dir = dirOf(path);
  // The root read is the folder picker's too; a subfolder is scanned on its own.
  const folder = useInspectSource(!l.linked && w.source && dir ? { ...w.source, dir } : null);
  const scan = (dir ? folder.data : found.data)?.found;
  const hasConfig = found.data ? hasSwarmyYaml(dir, found.data.tree) : false;
  const existing = w.source ? appAt(w.source.cloneUrl, path) : undefined;
  // Same repo + swarmy.yaml + branch is already an app; another branch is a new one.
  const app = existing?.branch === w.branch.trim() ? existing : undefined;
  const canLink = Boolean(w.source) && !l.linked && !l.link.isPending && !app;
  const label = w.source ? (dir || w.repoName) : null;
  const go = React.useCallback(() => {
    if (canLink) l.link.mutate(w.linkRequest());
  }, [canLink, l.link, w]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        go();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const words = l.linked
    ? { head: `${l.linked.fullName ?? l.linked.url} is linked`, sub: `Nothing deploys until you push to ${l.linked.branch}, or press Deploy now on CI & registry.` }
    : !w.connected
      ? { head: 'Connect a provider', sub: 'Pick where your code lives. We only read the repos you choose.' }
      : !w.source
        ? { head: 'Pick a repo', sub: 'We read it on one of your servers, read-only. Nothing is cloned to the controller.' }
        : app
          ? { head: `Already an app: ${app.name}`, sub: `${app.name} deploys from ${app.configPath} on ${app.branch}.` }
          : found.data
            ? foundWords(dir, found.data.tree, Boolean(found.data.composeDraft))
            : null;

  return (
    <section aria-label="What we found" className="calm-card flex flex-col gap-3 px-5 py-5">
      <div className="flex items-center gap-2">
        <span className="calm-eyebrow">What we found</span>
        {found.data && !l.linked ? (
          <span className="text-muted-foreground ml-auto font-mono text-[11px]">
            {w.source?.ref} @ {found.data.sha.slice(0, 7)} · read-only
          </span>
        ) : null}
      </div>
      {words ? (
        <>
          <h2 className="font-display text-[1.35rem] leading-tight font-bold tracking-[-0.02em]">{words.head}</h2>
          <p className="text-muted-foreground text-[13.5px] leading-relaxed">{words.sub}</p>
        </>
      ) : found.isError ? (
        <p className="text-muted-foreground text-[13.5px]">Couldn’t read it yet ({found.error.message}). You can still link it; it builds on the next push.</p>
      ) : (
        <TextSkeleton className="h-16 w-full rounded-xl" />
      )}
      {found.data && !app && !l.linked ? <GitFoundItems dir={dir} files={found.data.tree} detected={dir ? (folder.data?.detected ?? null) : found.data.detected} /> : null}
      {!app && !l.linked && !hasConfig ? (scan ? <GitFoundNeeds scan={scan} /> : dir && folder.isPending && found.data ? <TextSkeleton className="h-12 w-full rounded-xl" /> : null) : null}
      {l.linked ? (
        <Button asChild variant="outline" className="w-fit pointer-coarse:min-h-11">
          <Link to="/ci">Open CI & registry</Link>
        </Button>
      ) : app?.stack ? (
        <Button asChild variant="outline" className="w-fit pointer-coarse:min-h-11">
          <Link to="/stacks/$name" params={{ name: app.stack }}>Open {app.name}</Link>
        </Button>
      ) : w.connected ? (
        <>
          <Button size="lg" onClick={go} disabled={!canLink} className="pointer-coarse:min-h-11">
            {l.link.isPending ? 'Linking…' : label ? `Link & scan ${label}` : 'Link & scan'}
            <kbd className="bg-primary-foreground/15 hidden rounded px-1 font-mono text-[10.5px] sm:inline">{IS_MAC ? '⌘↵' : 'Ctrl ↵'}</kbd>
          </Button>
          <span className="text-muted-foreground font-mono text-[11.5px]">Nothing deploys yet — you see what we found first.</span>
        </>
      ) : null}
    </section>
  );
}
