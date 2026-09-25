import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';

interface Step {
  n: number;
  title: string;
  when: string;
  say: string;
  to: string;
}

function stepsFor(hasServer: boolean): Step[] {
  const deploy: Step = {
    n: 0, title: 'Deploy an app', when: '~2 min', to: '/deploy',
    say: 'Pick a template like Ghost or n8n, or bring a compose file, image or git repo.',
  };
  const domain: Step = {
    n: 0, title: 'Add a domain', when: 'when ready', to: '/network',
    say: 'Point your own name here; the certificate appears on its own.',
  };
  const server: Step = {
    n: 0, title: hasServer ? 'Add another server' : 'Add a server', when: hasServer ? 'optional' : '~5 min', to: '/nodes/new',
    say: 'Paste one line on any machine, a cloud box or one at home, and it joins privately.',
  };
  const order = hasServer ? [deploy, domain, server] : [server, deploy, domain];
  return order.map((s, i) => ({ ...s, n: i + 1 }));
}

/** The three first steps as numbered links; the first is the one to do now. */
export function WelcomeSteps({ hasServer }: { hasServer: boolean }): React.JSX.Element {
  return (
    <ol aria-label="First steps" className="flex max-w-2xl flex-col gap-2">
      {stepsFor(hasServer).map((s) => (
        <li key={s.title}>
          <Link
            to={s.to}
            className={cn(
              'calm-card flex items-start gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              s.n === 1 ? 'border-primary/50' : 'hover:border-foreground/25',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                s.n === 1 ? 'bg-primary/15 text-tone-bad' : 'border-border text-muted-foreground border',
              )}
            >
              {s.n}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-[14.5px] font-semibold">
                {s.title} <span className="text-muted-foreground ml-1 font-mono text-[11px] font-normal">{s.when}</span>
              </span>
              <span className="text-muted-foreground text-[13px]">{s.say}</span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
