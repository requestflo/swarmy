import * as React from 'react';
import { Say, SayHeader } from '@/components/calm';
import { PageSkeleton } from '@/components/states';
import { DeployingCode } from './deploying-code';
import { DeployingLog } from './deploying-log';
import { DeployingTracker } from './deploying-tracker';
import { stepDurations } from './deploy-durations';
import { useNow } from './deploy-elapsed';
import type { DeployWatch } from './use-deploy-progress';

/**
 * Board "Deploying", in Calm Layers: the sentence, the five-step tracker from
 * real signals, a quiet live log, and at Code the same watch from a terminal.
 * No coral here: there is nothing to press while it works. (No Cancel either:
 * removing a half-made app is `stacks.remove`, which leaves provisioned data
 * behind, so it stays on the app's Settings tab rather than one tap away.)
 */
export function DeployingView({
  stack,
  watch,
  banner,
}: {
  stack: string;
  watch: DeployWatch;
  /** The one-time secrets banner, right under the sentence. */
  banner?: React.ReactNode;
}): React.JSX.Element {
  const now = useNow();
  if (!watch.ready) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;
  // How long each streamed step has been working, from the deploy's start.
  const workingFor = Object.fromEntries(
    Object.entries(watch.startedAt).map(([k, sec]) => [k, watch.since ? Math.round((now - watch.since) / 1000) - sec : undefined]),
  ) as Partial<Record<keyof typeof watch.startedAt, number>>;
  const failed = watch.failed;
  const eyebrow = [failed ? 'STOPPED' : `STEP ${watch.current} OF ${watch.steps.length}`, watch.server].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-col gap-8">
      <SayHeader
        eyebrow={eyebrow}
        title={
          failed ? (
            <>
              {stack} <Say tone="bad">didn’t finish deploying.</Say>
            </>
          ) : (
            `Deploying ${stack}…`
          )
        }
        lede={
          failed
            ? `It stopped at “${failed.title}”. The live log below says why.`
            : 'You can leave this page. It keeps going, and we’ll tell you when it’s live.'
        }
      />
      {banner}
      <DeployingCode stackId={watch.stackId} service={watch.primary} domain={watch.domain} deployId={watch.deployId} />
      <div className="calm-card px-5 py-6 lg:px-6 lg:py-8">
        <DeployingTracker steps={watch.steps} took={stepDurations(watch.steps, watch.doneAt, watch.startedAt)} workingFor={workingFor} />
      </div>
      <DeployingLog service={watch.primary} server={watch.server} events={watch.events} streaming={watch.streaming} />
    </div>
  );
}
