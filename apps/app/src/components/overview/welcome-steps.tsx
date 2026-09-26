import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';

interface Step {
  title: string;
  when: string;
  say: string;
  to: string;
  done: boolean;
}

export interface WelcomeProgress {
  hasServer: boolean;
  /** At least one domain points here (null until known: shown as not done). */
  hasDomain: boolean;
  /** Two or more servers joined. */
  hasSecondServer: boolean;
}

function stepsFor(p: WelcomeProgress): Step[] {
  const deploy: Step = {
    title: 'Deploy an app', when: '~2 min', to: '/deploy', done: false,
    say: 'Pick a template like Ghost or n8n, or bring a compose file, image or git repo.',
  };
  const domain: Step = {
    title: 'Add a domain', when: 'when ready', to: '/network', done: p.hasDomain,
    say: 'Point your own name here; the certificate appears on its own.',
  };
  const server: Step = {
    title: p.hasServer ? 'Add another server' : 'Add a server', when: p.hasServer ? 'optional' : '~5 min', to: '/nodes/new',
    done: p.hasServer && p.hasSecondServer,
    say: 'Paste one line on any machine, a cloud box or one at home, and it joins privately.',
  };
  return p.hasServer ? [deploy, domain, server] : [server, deploy, domain];
}

/**
 * The three first steps as numbered links. The first one not yet done is the
 * current step (coral hairline); done steps get a tick and go quiet.
 */
export function WelcomeSteps(p: WelcomeProgress): React.JSX.Element {
  const steps = stepsFor(p);
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol aria-label="First steps" className="flex max-w-2xl flex-col gap-2">
      {steps.map((s, i) => {
        const now = i === current;
        return (
          <li key={s.title}>
            <Link
              to={s.to}
              aria-current={now ? 'step' : undefined}
              className={cn(
                'flex items-start gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                // calm-next: the coral hairline + wash the next thing wears (unlayered, so not a utility).
                now ? 'calm-next' : 'calm-card hover:border-foreground/25',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  now ? 'bg-primary/15 text-tone-bad' : s.done ? 'bg-status-online/15 text-tone-ok' : 'border-border text-muted-foreground border',
                )}
              >
                {s.done ? <CheckIcon className="size-3.5" /> : i + 1}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className={cn('text-[14.5px] font-semibold', s.done && 'text-muted-foreground')}>
                  {s.title}{' '}
                  <span className="text-muted-foreground ml-1 font-mono text-[11px] font-normal">{s.done ? 'done' : s.when}</span>
                </span>
                {s.done ? null : <span className="text-muted-foreground text-[13px]">{s.say}</span>}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
