import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { AppSignInMode } from '@swarmy/core';
import { cn, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { AppAccessViewData } from './types';

/** The app's sign-in mode: one value for all its protected addresses, else `mixed`. */
export function appSignIn(view: AppAccessViewData): AppSignInMode | 'mixed' | 'unreadable' | null {
  const modes = new Set(view.routes.filter((r) => r.requireLogin && !r.endUserAuth).map((r) => r.signIn));
  if (modes.size === 0) return null;
  if (modes.has('unreadable')) return 'unreadable';
  return modes.size > 1 ? 'mixed' : ([...modes][0] as AppSignInMode);
}

/**
 * How people sign in (Controls, the board's provider toggle): any swarmy
 * sign-in (password, GitHub, email link…, behind the org's own 2FA and
 * SSO-only rules) or only the organisation's single sign-on.
 */
export function SignInMethodCard({ stack, view }: { stack: string; view: AppAccessViewData }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.appAccess.setSignIn.mutationOptions({
      onSuccess: (_d, v) => {
        toast.success(v.mode === 'sso' ? 'Only single sign-on gets in now.' : 'Any swarmy sign-in gets in now.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const mode = appSignIn(view);
  if (mode === null) return null;
  const sso = view.ssoProviders.join(', ');
  const options: { value: AppSignInMode; title: string; sub: string; disabled?: boolean }[] = [
    { value: 'any', title: 'Any swarmy sign-in', sub: 'However your organisation signs in to swarmy, behind its 2FA and SSO-only rules.' },
    {
      value: 'sso',
      title: sso ? `Only ${sso}` : 'Only single sign-on',
      sub: sso ? 'People who signed in another way are asked to sign in with your company account.' : 'Set up single sign-on for your organisation first.',
      disabled: !sso,
    },
  ];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="say text-xl">
          How people <em>sign in</em>
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {mode === 'mixed'
            ? 'Its addresses disagree. Pick one to use on all of them.'
            : mode === 'unreadable'
              ? 'An address has a sign-in setting swarmy can’t read, so nobody gets in there. Pick one to fix it.'
              : 'Which sign-ins this app accepts, on every address that asks people to sign in.'}
        </p>
      </div>
      <div role="radiogroup" aria-label="Sign-in methods this app accepts" className="grid gap-3 sm:grid-cols-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={mode === o.value}
            disabled={o.disabled || set.isPending}
            onClick={() => set.mutate({ stack, mode: o.value })}
            className={cn('calm-card shadow-none min-h-11 p-4 text-left disabled:opacity-60', mode === o.value && 'border-foreground/40 bg-accent/40')}
          >
            <span className="block font-semibold">{o.title}</span>
            <span className="text-muted-foreground block text-sm">{o.sub}</span>
          </button>
        ))}
      </div>
      {!sso ? (
        <Link to="/settings/access" className="text-primary text-sm hover:underline">
          Set up single sign-on →
        </Link>
      ) : null}
      <Tech>{`swarmy.ingress.routes → access.signIn: ${mode === 'sso' ? '"sso"' : '(absent: any)'}`}</Tech>
    </section>
  );
}
