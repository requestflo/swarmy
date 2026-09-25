import * as React from 'react';
import type { DeployStatus } from '@swarmy/core';
import { Tech } from '@/components/calm';

interface ServiceDeployBannerProps {
  deploy: DeployStatus;
  desired: number;
}

/**
 * Live deploy banner shown while a service is converging. A navy ink statement
 * surface with a pulse dot and the mono ready/desired count — the page speaking.
 */
export function ServiceDeployBanner({ deploy, desired }: ServiceDeployBannerProps): React.JSX.Element {
  return (
    <div role="status" className="calm-card mb-2 flex flex-wrap items-center justify-between gap-4 px-5 py-3.5">
      <div className="flex items-center gap-3">
        <span aria-hidden className="bg-status-progress size-2 animate-pulse rounded-full motion-reduce:animate-none" />
        <div>
          <p className="text-tone-info text-sm font-semibold">Rolling out</p>
          {deploy.message ? (
            <p className="text-muted-foreground mt-0.5 max-w-xl truncate font-mono text-xs">{deploy.message}</p>
          ) : (
            <Tech>{deploy.kind} · {deploy.phase}</Tech>
          )}
        </div>
      </div>
      <p className="text-muted-foreground text-sm">
        <span className="text-foreground font-mono text-base">
          {deploy.ready ?? 0} of {deploy.desired ?? desired}
        </span>{' '}
        copies ready
      </p>
    </div>
  );
}
