import * as React from 'react';
import { Button } from '@swarmy/ui';
import { CardSkeleton } from '@/components/states';
import { rolesAtAGlance, type RoleKey } from './role-lines';
import type { PolicyRow } from './use-policy-editor';

const ROLE_WORD: Record<RoleKey, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** What each role means here, in the org's own rule titles (defaults plus anything an admin added). */
export function RolesAtAGlance({ rules, onInvite }: { rules: PolicyRow[] | undefined; onInvite?: () => void }): React.JSX.Element {
  if (!rules) return <CardSkeleton lines={4} />;
  const glance = rolesAtAGlance(rules);
  return (
    <section aria-labelledby="roles-glance" className="calm-card flex flex-col gap-3 px-5 py-4">
      <h2 id="roles-glance" className="font-display text-[16.5px] font-bold tracking-[-0.01em]">
        Roles at a glance
      </h2>
      <dl className="flex flex-col gap-2.5 text-[13px] leading-snug">
        {glance.roles.map(({ role, lines }) => (
          <div key={role}>
            <dt className="font-semibold">{ROLE_WORD[role]}</dt>
            <dd className="text-muted-foreground">{lines.length ? `${lines.join('. ')}.` : 'No rule gives this role anything yet.'}</dd>
          </div>
        ))}
        {glance.grants.length ? (
          <div>
            <dt className="font-semibold">With an app picked</dt>
            <dd className="text-muted-foreground">{`${glance.grants.join('. ')}.`}</dd>
          </div>
        ) : null}
      </dl>
      {onInvite ? (
        <Button variant="outline" className="w-fit pointer-coarse:min-h-11" onClick={onInvite}>
          Invite someone
        </Button>
      ) : null}
    </section>
  );
}
