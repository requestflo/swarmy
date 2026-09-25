import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Skeleton, toast } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';

/**
 * The one org-level 2FA knob: an opt-in switch, off by default. On means every
 * member with a password account must add an authenticator app within a week.
 * People who sign in only through SSO or a social account are never asked:
 * their identity provider owns MFA (and many of them have no email to recover
 * a password account with).
 */
export function Require2faCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policy = useQuery(trpc.security.policy.get.queryOptions());
  const save = useMutation(
    trpc.security.policy.set.mutationOptions({
      onSuccess: (p) => {
        toast.success(p.require2fa === 'off' ? 'Two-factor is optional again' : 'Two-factor is now required');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const on = policy.data ? policy.data.require2fa !== 'off' : false;

  return (
    <Section title="Workspace two-factor">
        {!policy.data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <label className="flex items-start gap-3 text-sm">
            <QuietSwitch
              checked={on}
              disabled={save.isPending}
              onCheckedChange={(v) =>
                save.mutate({ require2fa: v ? 'all' : 'off', trustIdpMfa: true, graceDays: policy.data?.graceDays ?? 7 })
              }
            />
            <span>
              Require two-factor for password accounts
              <span className="text-muted-foreground block">
                Off by default: two-factor is each person&rsquo;s choice. When on, people who sign in with a password
                get {policy.data.graceDays} days to add an authenticator app. Anyone signing in with SSO or a social
                account is never asked; their provider handles MFA.
              </span>
            </span>
          </label>
        )}
      </Section>
  );
}
