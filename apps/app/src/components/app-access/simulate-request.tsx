import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth, Section, TONE_DOT } from '@/components/calm';
import { IdentityHeaders } from './identity-headers';
import { RequestFlow } from './request-flow';
import { addressOptions, canEnterPath } from './path-rules-model';
import { personName, simulateRequest } from './simulate';
import { WhoCanEnterPath } from './who-can-enter-path';
import type { AppAccessViewData } from './types';

const STRANGER = 'stranger';

/**
 * "Request to … · Simulate" (AppAccess board): pick an address and a person
 * (one of your members, or a stranger with no session) and watch the request
 * walk Visitor → front door → sign-in check → what answers, decided by the
 * app's real access rules — its path rules included (each rule's path is an
 * address to pick). Then who can enter that address; from Controls, the
 * headers the app would get.
 */
export function SimulateRequest({ stack, view }: { stack: string; view: AppAccessViewData }): React.JSX.Element | null {
  const options = addressOptions(view.routes.filter((r) => !r.endUserAuth));
  const [key, setKey] = React.useState(() => (options.find((o) => o.route.requireLogin) ?? options[0])?.key);
  const [who, setWho] = React.useState<string>(STRANGER);
  const sel = options.find((o) => o.key === key) ?? options[0];
  if (!sel) return null;
  const route = { ...sel.route, path: sel.path };
  const person = view.people.find((p) => p.memberId === who) ?? null;
  const sim = simulateRequest(sel.route, person, stack, sel.path, view.people);

  return (
    <Section title={`Request to ${sel.label}`} hint="Simulate who gets in">
      {options.length > 1 ? (
        <Chips label="Address">
          {options.map((o) => (
            <Chip key={o.key} on={o.key === sel.key} onClick={() => setKey(o.key)}>
              {o.label}
            </Chip>
          ))}
        </Chips>
      ) : null}
      <Chips label="Simulate">
        {view.people.map((p) => (
          <Chip key={p.memberId} on={who === p.memberId} onClick={() => setWho(p.memberId)} dot={canEnterPath(sel.route, p, sel.path) ? 'ok' : 'bad'}>
            {p.email ?? personName(p)}
          </Chip>
        ))}
        <Chip on={who === STRANGER} onClick={() => setWho(STRANGER)} dot="bad">
          a stranger
        </Chip>
      </Chips>
      <RequestFlow stack={stack} route={route} person={person} sim={sim} />
      {sel.route.requireLogin ? <WhoCanEnterPath view={view} route={sel.route} path={sel.path} label={sel.label} /> : null}
      <Depth at="controls">
        <IdentityHeaders stack={stack} route={route} person={person} sim={sim} />
      </Depth>
    </Section>
  );
}

function Chips({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground mr-1 text-xs">{label}</span>
      {children}
    </div>
  );
}

function Chip({ on, onClick, dot, children }: { on: boolean; onClick: () => void; dot?: 'ok' | 'bad'; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'pointer-coarse:min-h-11 flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11.5px]',
        on ? 'border-foreground/40 bg-accent font-semibold' : 'text-muted-foreground hover:bg-accent/60',
      )}
    >
      {dot ? <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[dot])} /> : null}
      {children}
    </button>
  );
}
