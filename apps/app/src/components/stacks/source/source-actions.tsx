import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import type { GitApp } from '@/components/gitops/gitops-types';
import { repoFileUrl } from './repo-link';

/** The page's one coral: "Edit in git ↗" to the spec file; not linked, an outline "Link a repo" to the git flow. */
export function SourceActions({ app, branch }: { app: GitApp | null; branch?: string }): React.JSX.Element {
  const href = app ? repoFileUrl(app.url, branch ?? app.branch, app.configPath) : null;
  if (href) {
    return (
      <Button asChild>
        <a href={href} target="_blank" rel="noreferrer">
          Edit in git <ArrowUpRightIcon aria-hidden className="size-4" />
        </a>
      </Button>
    );
  }
  return (
    <Button asChild variant="outline">
      <Link to="/ci">Link a repo</Link>
    </Button>
  );
}
