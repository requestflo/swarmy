import * as React from 'react';
import type { PublicStatusView, StatusPageView } from '@swarmy/core';
import { CardSkeleton } from '@/components/states';
import { PublicStatusBody } from './public-status-body';

/**
 * LIVE PREVIEW — the public page in a browser frame, rendered by the same
 * body `/s/$slug` uses from the same snapshot, so what you see is what a
 * visitor sees right now.
 */
export function StatusPreview({ page, snapshot }: { page: StatusPageView; snapshot?: PublicStatusView }): React.JSX.Element {
  const url = page.domain ? `https://${page.domain}` : `${typeof window === 'undefined' ? '' : window.location.origin}${page.publicPath}`;
  return (
    <section aria-label="Live preview" className="flex min-w-0 flex-col gap-2">
      <p className="calm-eyebrow uppercase">Live preview · what a visitor sees right now</p>
      <div className="border-border bg-card overflow-hidden rounded-2xl border shadow-sm">
        <div className="border-border bg-muted/60 flex items-center gap-3 border-b px-4 py-2.5">
          <span aria-hidden className="flex gap-1.5">
            <span className="bg-foreground/15 size-2.5 rounded-full" />
            <span className="bg-foreground/15 size-2.5 rounded-full" />
            <span className="bg-foreground/15 size-2.5 rounded-full" />
          </span>
          <a href={page.publicPath} target="_blank" rel="noreferrer" className="text-muted-foreground min-w-0 truncate font-mono text-[11.5px] hover:underline">
            {url}
          </a>
        </div>
        <div className="bg-background px-4 py-5 sm:px-6">
          {!page.enabled ? (
            <p className="text-muted-foreground py-10 text-center text-sm">The page is switched off. Visitors get “not found”.</p>
          ) : snapshot ? (
            <PublicStatusBody snapshot={snapshot} compact />
          ) : (
            <CardSkeleton lines={4} />
          )}
          <p className="text-muted-foreground mt-6 text-center text-xs">Powered by swarmy · times in your timezone</p>
        </div>
      </div>
    </section>
  );
}
