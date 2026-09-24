import * as React from 'react';
import { CheckIcon, FileCode2Icon } from 'lucide-react';
import { Badge, Button } from '@swarmy/ui';
import type { LinkedRepo } from './git-types';
import type { GitInspect } from './use-git-inspect';

interface GitLinkDetectProps {
  linked: LinkedRepo;
  inspect: GitInspect;
  /** Point the app at a different swarmy.yaml (monorepos). */
  onUsePath: (configPath: string) => void;
  switching: boolean;
}

const where = (p: string): string => p.replace(/\/?swarmy\.ya?ml$/, '') || 'the repo root';
const DOCKERFILE = /(^|\/)Dockerfile$/;
const COMPOSE = /(^|\/)(docker-)?compose\.ya?ml$/;

/** Read the linked commit on a builder and say what's in it: swarmy.yaml(s), Dockerfile, compose. */
export function GitLinkDetect({
  linked,
  inspect,
  onUsePath,
  switching,
}: GitLinkDetectProps): React.JSX.Element {
  if (inspect.isPending || inspect.isIdle) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <span className="pulse-dot" /> Reading {linked.branch} on a builder…
      </p>
    );
  }
  if (inspect.isError) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <p className="text-muted-foreground">
          Couldn’t read the repo yet: {inspect.error.message}. It still builds on the next push.
        </p>
        <Button variant="outline" size="sm" onClick={() => inspect.mutate({ repoId: linked.id })}>
          Try again
        </Button>
      </div>
    );
  }

  const { sha, configPaths, tree } = inspect.data;
  const dockerfile = tree.find((p) => DOCKERFILE.test(p));
  const compose = tree.find((p) => COMPOSE.test(p));

  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground mono-label">
        {linked.branch} @ {sha.slice(0, 7)}
      </p>
      {configPaths.length > 0 && !configPaths.includes(linked.configPath) ? (
        <p>
          Nothing at <span className="mono-data">{linked.configPath}</span> — pick the one this app
          deploys.
        </p>
      ) : null}
      {configPaths.length > 0 ? (
        <ul className="space-y-1.5">
          {configPaths.map((p) => (
            <li key={p} className="flex flex-wrap items-center gap-2">
              <FileCode2Icon className="text-status-online size-4" />
              <span>
                Found swarmy.yaml in <span className="mono-data">{where(p)}</span>
              </span>
              {p === linked.configPath ? (
                <Badge variant="muted">
                  <CheckIcon className="size-3" /> in use
                </Badge>
              ) : (
                <Button variant="ghost" size="sm" disabled={switching} onClick={() => onUsePath(p)}>
                  Use this one
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No swarmy.yaml yet.{' '}
          {dockerfile
            ? `Found a Dockerfile at ${dockerfile} — swarmy can build it.`
            : compose
              ? `Found ${compose} — it can seed your swarmy.yaml.`
              : `Add ${linked.configPath} to the repo and push.`}
        </p>
      )}
    </div>
  );
}
