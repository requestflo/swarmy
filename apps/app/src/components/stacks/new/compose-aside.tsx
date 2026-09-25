import * as React from 'react';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { AlreadyOn, CodeView, Tech, curl } from '@/components/calm';
import type { ComposeCheck } from './use-compose-check';

/**
 * The compose deploy's aside: the file as REST (Code), what deploying it
 * does, and the one coral Deploy button.
 */
export function ComposeAside({
  name,
  compose,
  envSource,
  check,
  ready,
  pending,
  onDeploy,
}: {
  name: string;
  compose: string;
  envSource: string;
  check: ComposeCheck;
  ready: boolean;
  pending: boolean;
  onDeploy: () => void;
}): React.JSX.Element {
  const n = check.services.length;
  const body = { name: name || 'my-app', compose_source: compose || 'services: {}' };
  return (
    <>
      <CodeView
        tabs={[{ label: 'REST', code: curl('POST', '/stacks', body) }]}
        note={envSource.trim() ? 'The .env values are filled in by the dashboard before the call; over REST, substitute them first.' : 'The same deploy over REST. It returns at once and the app rolls out in the background.'}
      />
      <section aria-label="What happens" className="calm-card flex flex-col gap-3 px-5 py-5">
        <h2 className="font-display text-[1.2rem] font-bold tracking-[-0.01em]">
          {check.status === 'ok' ? `${n} service${n === 1 ? '' : 's'}, one app.` : 'Everything goes up at once.'}
        </h2>
        <AlreadyOn
          bare
          items={[
            { what: 'One app', detail: name ? `every service lands in ${name}` : 'every service lands in its own workspace' },
            { what: 'Checked first', detail: 'swarmy reads the file as you type; nothing runs until you press Deploy' },
            { what: 'No surprises', detail: 'anything swarm can’t use is listed before you deploy' },
          ]}
        />
        {check.status === 'ok' ? <Tech>{check.services.join(' · ')}</Tech> : null}
        <Button size="lg" className="pointer-coarse:min-h-11 mt-1 w-full" disabled={!ready || pending} onClick={onDeploy}>
          {pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {name ? `Deploy ${name}` : 'Deploy'}
        </Button>
      </section>
    </>
  );
}
