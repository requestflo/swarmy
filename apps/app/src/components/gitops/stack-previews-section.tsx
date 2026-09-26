import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Section, SectionLink } from '@/components/calm';
import { AppEnvironmentsList } from './app-environments-list';
import type { StackAppMatch } from './gitops-types';

/**
 * Branch and PR previews of this app (board BranchPreviews), one row each —
 * moved here from Releases. Not linked to git: the section says how to get them.
 */
export function StackPreviewsSection({ stack, match }: { stack: string; match: StackAppMatch | null }): React.JSX.Element {
  const previews = match?.app.previews ?? [];
  return (
    <Section title="Branch previews" count={match ? previews.length : undefined} hint="a copy of the app per branch or pull request" flush>
      {match && previews.length ? (
        <AppEnvironmentsList app={match.app} stack={stack} show="previews" />
      ) : (
        <p className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 px-1 py-3 text-[13.5px]">
          {match
            ? 'No previews running. Open a pull request and swarmy starts one, then removes it when the PR closes.'
            : 'Previews come from git: every pull request gets its own copy of the app.'}
          {match ? null : (
            <Link to="/ci" className="pointer-coarse:min-h-11 content-center">
              <SectionLink>Link a repo →</SectionLink>
            </Link>
          )}
        </p>
      )}
    </Section>
  );
}
