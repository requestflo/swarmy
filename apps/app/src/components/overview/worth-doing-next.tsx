import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Section } from '@/components/calm';
import type { SetupFacts } from './use-setup-facts';

export interface SetupStep {
  done: boolean;
  label: string;
  why: string;
  to: string;
}

export function setupSteps(f: SetupFacts, x: { apps: number; servers: number; channels: number }): SetupStep[] {
  return [
    { done: x.apps > 0, label: 'Deploy your first app', why: 'A template or your own repo, online in minutes.', to: '/deploy' },
    { done: f.domainCount > 0, label: 'Add your own domain', why: 'swarmy checks your DNS and gets the certificate.', to: '/network' },
    { done: f.members > 1, label: 'Invite a teammate', why: 'So you are not the only one who can fix things.', to: '/settings/access' },
    { done: x.servers > 1, label: 'Add a second server', why: 'Your apps keep running if one server fails.', to: '/nodes/new' },
    { done: f.backupTargets.length > 0, label: 'Choose where backups go', why: 'Nightly copies of every database and volume.', to: '/backups' },
    { done: x.channels > 0, label: 'Get alerts where you will see them', why: 'Email, Slack or a webhook when something needs you.', to: '/alerts' },
    { done: f.meshOn, label: 'Connect your servers privately', why: 'One private network, no open ports.', to: '/networking' },
  ];
}

/** "Worth doing next": the setup steps still open, as quiet links. Gone once everything is done. */
export function WorthDoingNext({ steps }: { steps: SetupStep[] }): React.JSX.Element | null {
  const open = steps.filter((s) => !s.done);
  if (open.length === 0) return null;
  return (
    <Section title="Worth doing next" count={`${steps.length - open.length} of ${steps.length} done`}>
      <ul className="flex flex-col">
        {open.slice(0, 4).map((s) => (
          <li key={s.label}>
            <Link
              to={s.to}
              className="hover:bg-foreground/[0.025] flex min-h-11 items-start gap-2.5 rounded-sm px-1 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span aria-hidden className="bg-foreground/25 mt-[7px] size-2 shrink-0 rounded-full" />
              <span className="flex flex-col">
                <span className="text-[13.5px] font-medium">{s.label}</span>
                <span className="text-muted-foreground text-[12.5px]">{s.why}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
