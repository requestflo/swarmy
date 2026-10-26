import * as React from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { Button, Input, Label } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { agoLabel, momentLabel } from './time-travel-model';
import { skewSentence, whenLabel } from './app-restore-words';
import { AppRestoreParts } from './app-restore-parts';
import type { AppRestore } from './use-app-restore';

interface AppRestoreCardProps {
  stack: string;
  at: number;
  now: number;
  app: AppRestore;
  /** Move the head (to the earliest moment every part reaches). */
  onGo: (t: number) => void;
}

/**
 * Put the whole app back to the head: every saved volume and database, each
 * to its nearest point at or before it, the gap between them said plainly.
 * The app stops once; each part is saved as it is first; a failed part puts
 * the others back. Needs the app's name typed back.
 */
export function AppRestoreCard({ stack, at, now, app, onGo }: AppRestoreCardProps): React.JSX.Element {
  const [typed, setTyped] = React.useState('');
  const confirmId = React.useId();
  const { scope, plan } = app;
  const title = `Put all of ${stack} back to ${momentLabel(at)}`;
  if (!scope || !plan) {
    return (
      <Section title={title} hint={agoLabel(at, now)}>
        {app.error ? <p className="text-tone-bad text-[13px]">Couldn&rsquo;t read what {stack} keeps.</p> : <CardSkeleton lines={3} />}
      </Section>
    );
  }
  if (plan.parts.length === 0 && plan.refused.length === 0) {
    return (
      <Section title={title} hint={agoLabel(at, now)}>
        <p className="text-muted-foreground text-[13px]">{stack} has no saved files or databases yet. Its first nightly backup makes this possible.</p>
      </Section>
    );
  }
  const stops = scope.stops.map((s) => s.service.replace(`${stack}_`, ''));
  return (
    <Section title={title} hint={agoLabel(at, now)}>
      {plan.ok ? (
        <p className="text-[13.5px]">{skewSentence(plan, stack)}</p>
      ) : (
        <p className="text-tone-bad text-[13.5px]">
          Not everything goes back this far, so the whole app can&rsquo;t.
          {plan.reachesFrom !== null ? (
            <>
              {' '}Every part reaches back to {whenLabel(plan.reachesFrom, at)}.{' '}
              <button type="button" onClick={() => onGo(plan.reachesFrom!)} className="text-primary font-medium hover:underline pointer-coarse:min-h-11">
                Go there
              </button>
            </>
          ) : null}
        </p>
      )}
      <AppRestoreParts stack={stack} plan={plan} scope={scope} />
      <p className="text-muted-foreground text-[12.5px] leading-snug">
        {stops.length ? `${stack} stops once (${stops.join(', ')}), ` : ''}each part is saved as it is now and then put back
        {stops.length ? `, and ${stack} starts again` : ''}. If one fails, the parts already put back are restored from those saves.
      </p>
      <Tech>backups.restoreApp · data.restore · one app.restore audit row · {plan.parts.length} parts · {Math.round(plan.skewMs / 1000)} s apart</Tech>
      {app.result ? (
        <p role="status" className="text-tone-ok text-[13px]">
          {stack} is back as it was at {momentLabel(Date.parse(app.result.at))}: {app.result.parts.length} parts restored. The copies saved just before are on the Backups tab.
          {app.result.startError ? <span className="text-tone-warn block">{app.result.startError}</span> : null}
        </p>
      ) : null}
      {app.failure ? <p role="alert" className="text-tone-bad text-[13px]">{app.failure.message}</p> : null}
      {plan.ok ? (
        <div className="grid gap-1.5">
          <Label htmlFor={confirmId} className="text-muted-foreground text-[12.5px]">
            Type <span className="text-foreground font-mono">{stack}</span> to confirm
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id={confirmId} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={stack} autoComplete="off" spellCheck={false} className="sm:max-w-56" />
            <Button
              variant="outline"
              disabled={typed.trim() !== stack || app.running}
              onClick={() => {
                app.restore(typed.trim());
                setTyped('');
              }}
              className="border-tone-bad text-tone-bad pointer-coarse:min-h-11"
            >
              {app.running ? <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
              {app.running ? `Putting ${stack} back…` : `Put the whole app back`}
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
