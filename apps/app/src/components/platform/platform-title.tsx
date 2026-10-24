import * as React from 'react';
import { Say } from '@/components/calm';
import type { PlatformStatus } from './use-platform';

/** The Platform page's sentence: the run first (live, paused, being put back, stopped), else the version you run. */
export function platformTitle(v: PlatformStatus | undefined): React.ReactNode {
  if (!v) return 'swarmy itself.';
  const run = v.run;
  const av = v.release.available;
  const current = v.release.current.version;
  if (run?.status === 'running') {
    return (
      <>
        Upgrading to {run.toVersion}. <em>Apps keep serving.</em>
      </>
    );
  }
  if (run?.status === 'paused') {
    return (
      <>
        Part-way to {run.toVersion}. <Say tone="warn">The upgrade is paused.</Say>
      </>
    );
  }
  if (run?.status === 'abandoning') {
    return (
      <>
        Going back to {run.fromVersion}. <em>Apps keep serving.</em>
      </>
    );
  }
  if (run?.status === 'failed') {
    return (
      <>
        You’re on {current}. <Say tone="bad">The upgrade to {run.toVersion} stopped.</Say>
      </>
    );
  }
  if (av) {
    return (
      <>
        You’re on {current}. <Say tone="info">{av.version} is ready.</Say>
      </>
    );
  }
  return (
    <>
      You’re on {current}. <em>Up to date.</em>
    </>
  );
}
