import * as React from 'react';
import type { DeployStatus } from '@swarmy/core';

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
    <div className="ink-block mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl px-6 py-5">
      <div className="flex items-center gap-3">
        <span className="pulse-dot" />
        <div>
          <p className="mono-label text-ink-foreground/70">Deploying</p>
          <p className="font-display text-lg font-bold capitalize">{deploy.phase}</p>
        </div>
      </div>
      <p className="text-ink-foreground/80 text-sm">
        <span className="mono-data text-ink-foreground text-base">
          {deploy.ready ?? 0} / {deploy.desired ?? desired}
        </span>{' '}
        replicas ready
      </p>
    </div>
  );
}
