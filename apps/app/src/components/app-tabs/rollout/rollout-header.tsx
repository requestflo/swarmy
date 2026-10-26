import * as React from 'react';
import { errorTripWatchSec, tripPctWords, type DeploySafetyView } from '@swarmy/core';
import { SayHeader } from '@/components/calm';

/** "Each change is watched for 2 minutes, then kept or put back." */
export function RolloutHeader({ safety }: { safety: DeploySafetyView }): React.JSX.Element {
  // With the error trip on, the gate watches at least long enough for its whole minutes.
  const watchSec = safety.errorTripPct !== null ? Math.max(safety.windowSec, errorTripWatchSec()) : safety.windowSec;
  const mins = Math.max(1, Math.round(watchSec / 60));
  const trip =
    safety.enabled && safety.errorTripPct !== null
      ? ` It ${safety.autoRollback ? 'puts a version back' : 'fails a version'} early when more than ${tripPctWords(safety.errorTripPct)} of requests fail.`
      : '';
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
      lede={`Stored on the app itself, so it holds even if the controller is away.${trip} A canary in flight shows on Releases.`}
    />
  );
}
