import * as React from 'react';
import { StatusBadge } from '@swarmy/ui';
import type { AppEnvironment } from './gitops-types';
import { envLabel, planStatus, sha7 } from './plan-status';

interface AppEnvChipProps {
  env: AppEnvironment;
  onOpen: (planId: string) => void;
}

/** One environment in the strip: name, branch, last commit, and how it's doing. */
export function AppEnvChip({ env, onOpen }: AppEnvChipProps): React.JSX.Element {
  const latest = env.latest;
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{envLabel(env.environment)}</span>
        <span className="text-muted-foreground mono-label">
          {latest ? sha7(latest.sha) : env.branch}
        </span>
      </span>
      {latest ? (
        <StatusBadge {...planStatus(latest.status)} />
      ) : (
        <span className="text-muted-foreground text-xs">
          Waiting for the first push to {env.branch}
        </span>
      )}
    </>
  );
  const cls = 'flex min-w-44 flex-1 flex-col gap-1 rounded-xl border px-4 py-3 text-left';
  return latest ? (
    <button
      type="button"
      onClick={() => onOpen(latest.id)}
      className={`${cls} hover:bg-accent/60 transition-colors`}
    >
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}
