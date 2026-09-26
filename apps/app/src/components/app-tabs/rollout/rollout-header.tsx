import * as React from 'react';
import type { DeploySafetyView } from '@swarmy/core';
import { SayHeader } from '@/components/calm';

/** "Each change is watched for 2 minutes, then kept or put back." */
export function RolloutHeader({ safety }: { safety: DeploySafetyView }): React.JSX.Element {
  const mins = Math.max(1, Math.round(safety.windowSec / 60));
  const title = !safety.enabled ? (
    <>
      Changes go out one copy at a time. <em>Nothing watches them afterwards.</em>
    </>
  ) : safety.autoRollback ? (
    <>
      Each change is watched for {mins} min <em>and put back if it gets worse.</em>
    </>
  ) : (
    <>
      Each change is watched for {mins} min. <em>You decide whether to put it back.</em>
    </>
  );
  return (
    <SayHeader
      size="md"
      title={title}
      lede="Stored on the app itself, so it holds even if the controller is away. A canary in flight shows on Releases."
    />
  );
}
