import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';

/**
 * "Moving an app from somewhere else?" — the importers, under the four ways
 * in. Coolify's templates already sit on the shelf below (seeded by the
 * Coolify importer); Heroku apps come across through their own page.
 */
export function ImportFrom(): React.JSX.Element {
  return (
    <nav aria-label="Import an app" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
      <span className="text-muted-foreground">Moving an app from somewhere else?</span>
      <Link
        to="/deploy/heroku"
        className="text-foreground inline-flex min-h-8 items-center gap-1 font-semibold underline-offset-4 hover:underline pointer-coarse:min-h-11"
      >
        Import from Heroku
        <ArrowRightIcon aria-hidden className="size-3.5" />
      </Link>
      <span className="text-muted-foreground font-mono text-[11px]">token or app.json + Procfile · nothing on Heroku changes</span>
    </nav>
  );
}
