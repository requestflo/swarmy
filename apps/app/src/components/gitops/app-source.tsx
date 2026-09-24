import * as React from 'react';
import { GitBranchIcon } from 'lucide-react';
import type { GitApp } from './gitops-types';

/** `northwind/orders@main · swarmy.yaml` — where this app is defined. */
export function AppSource({ app, branch }: { app: GitApp; branch?: string }): React.JSX.Element {
  return (
    <p className="text-muted-foreground mono-label flex items-center gap-1.5 truncate">
      <GitBranchIcon className="size-3.5 shrink-0" />
      <span className="truncate">
        {app.fullName ?? app.url}@{branch ?? app.branch} · {app.configPath}
      </span>
    </p>
  );
}
