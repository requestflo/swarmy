import * as React from 'react';
import { Say, SayHeader } from '@/components/calm';
import { PageSkeleton } from '@/components/states';
import { DeployingCode } from './deploying-code';
import { DeployingLog } from './deploying-log';
import { DeployingTracker, clock } from './deploying-tracker';
import type { DeployWatch } from './use-deploy-progress';

/** A ticking "0:28 elapsed" from when the deploy went out (only when this tab sent it). */
function Elapsed({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return <span className="text-muted-foreground font-mono text-[12px]">{clock(Math.max(0, Math.round((now - startedAt) / 1000)))} elapsed</span>;
}

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
  startedAt,
  banner,
}: {
  stack: string;
  watch: DeployWatch;
  startedAt: number | null;
  /** The one-time secrets banner, right under the sentence. */
  banner?: React.ReactNode;
}): React.JSX.Element {
  if (!watch.ready) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;
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
        actions={startedAt && !failed ? <Elapsed startedAt={startedAt} /> : undefined}
      />
      {banner}
      <DeployingCode stackId={watch.stackId} service={watch.primary} domain={watch.domain} />
      <div className="calm-card px-5 py-6 lg:px-6 lg:py-8">
        <DeployingTracker steps={watch.steps} doneAt={watch.doneAt} />
      </div>
      <DeployingLog service={watch.primary} server={watch.server} />
    </div>
  );
}
