import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { PageDepthSwitch } from './depth-dial';

export interface Crumb {
  label: string;
  /** Omit on the last crumb (the current page). */
  to?: string;
  params?: Record<string, string>;
}

/** The 52px top bar: a mono breadcrumb, quiet page actions, and this page's depth switch. */
export function CalmTopBar({
  crumbs,
  meta,
  actions,
}: {
  crumbs: Crumb[];
  /** Quiet facts beside the breadcrumb (a "1 needs you" pill, a mono summary). */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <header className="border-border flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-2 border-b px-6 py-2 xl:px-8">
      <nav aria-label="Breadcrumb" className="calm-crumb min-w-0 truncate">
        {crumbs.map((c, i) => (
          <React.Fragment key={`${c.label}-${i}`}>
            {i > 0 ? <span aria-hidden className="px-1.5 opacity-60">/</span> : null}
            {c.to ? (
              <Link to={c.to} params={c.params as never} className="hover:text-foreground inline-flex items-center pointer-coarse:min-h-11">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-foreground/80">{c.label}</span>
            )}
          </React.Fragment>
        ))}
      </nav>
      {meta ? <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{meta}</div> : null}
      <div className="flex-1" />
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      <PageDepthSwitch />
    </header>
  );
}

/**
 * A Calm Layers page: top bar, then a main column and an optional aside
 * (380px on xl). At Code depth pages put a `CodeView` at the top of the aside —
 * it adds to the page, nothing else moves.
 */
export function CalmPage({
  crumbs,
  meta,
  actions,
  aside,
  children,
  wide,
  className,
}: {
  crumbs: Crumb[];
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  /** Let the main column run full width (canvases, tables). */
  wide?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-col">
      <CalmTopBar crumbs={crumbs} meta={meta} actions={actions} />
      <div
        className={cn(
          'mx-auto grid w-full gap-7 px-6 pt-7 pb-24 lg:pb-16 xl:px-8',
          wide ? 'max-w-[1600px]' : 'max-w-[1440px]',
          aside ? 'xl:grid-cols-[minmax(0,1fr)_400px]' : 'grid-cols-1',
          className,
        )}
      >
        <div className="flex min-w-0 flex-col gap-5">{children}</div>
        {aside ? <aside className="flex min-w-0 flex-col gap-4">{aside}</aside> : null}
      </div>
    </div>
  );
}
