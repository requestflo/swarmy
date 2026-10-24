import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import type { GitApp } from '@/components/gitops/gitops-types';
import { repoFileUrl } from './repo-link';

/**
 * The page's one coral: "Edit in git ↗" to the spec file. Not linked: an
 * outline "Link a repo" to the git flow — with, for an app deployed from
 * compose (`convert`), the coral "Convert to swarmy.yaml" first.
 */
export function SourceActions({ app, branch, convert }: { app: GitApp | null; branch?: string; convert?: string }): React.JSX.Element {
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
    <>
      {convert ? (
        <Button asChild className="pointer-coarse:min-h-11">
          <Link to="/stacks/$name/source" params={{ name: convert }} search={{ convert: true }}>
            Convert to swarmy.yaml
          </Link>
        </Button>
      ) : null}
      <Button asChild variant="outline" className="pointer-coarse:min-h-11">
        <Link to="/ci">Link a repo</Link>
      </Button>
    </>
  );
}
