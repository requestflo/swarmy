import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import { Button, Label, Switch, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { BREAK_GLASS_NOTE, ssoOnlyBlocker, ssoOnlyLine, TURN_ON_CONSEQUENCE } from './sso-only-words';
import { useSsoOnly } from './use-sso-only';

type Role = 'owner' | 'admin' | 'member';

/**
 * "Members sign in with SSO only" (boards 48 and 56): the switch, what it
 * means in plain words, and the owners' break-glass. Turning it on signs
 * people out, so it asks once before it does.
 */
export function SsoOnlyCard({ role }: { role: Role }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const state = useSsoOnly();
  const [confirming, setConfirming] = React.useState(false);
  const set = useMutation(
    trpc.security.ssoOnly.set.mutationOptions({
      onSuccess: (r) => {
        setConfirming(false);
        const out = r.signedOut ? ` ${r.signedOut} ${r.signedOut === 1 ? 'person was' : 'people were'} signed out.` : '';
        toast.success(r.on ? `Members now sign in with SSO only.${out}` : 'Members can use any sign-in that is on again.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!state) return <CardSkeleton lines={2} />;
  const blocker = ssoOnlyBlocker(state, role);
  const canEdit = role === 'owner' || role === 'admin';

  return (
    <div id="sso-only" className="grid gap-2 border-t py-3 text-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor="sso-only-switch" className="flex items-center gap-1.5 text-sm font-semibold">
            <ShieldCheckIcon className="text-muted-foreground size-4" /> Members sign in with SSO only
          </Label>
          <p className="text-[13.5px] leading-snug">{ssoOnlyLine(state)}</p>
        </div>
        {canEdit ? (
          <Switch
            id="sso-only-switch"
            checked={state.on || confirming}
            disabled={set.isPending || (!state.on && blocker !== null)}
            onCheckedChange={(v) => (v ? setConfirming(true) : confirming ? setConfirming(false) : set.mutate({ on: false }))}
          />
        ) : null}
      </div>
      {confirming ? (
        <div className="bg-muted/50 flex flex-wrap items-center gap-3 rounded-[10px] border px-3.5 py-3" aria-live="polite">
          <p className="min-w-[14rem] flex-1">{TURN_ON_CONSEQUENCE}</p>
          <Button variant="outline" className="pointer-coarse:min-h-11" disabled={set.isPending} onClick={() => set.mutate({ on: true })}>
            {set.isPending ? 'Turning on…' : 'Turn on SSO only'}
          </Button>
          <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {!state.on && blocker && canEdit ? <p className="text-tone-warn text-[13px] font-medium">{blocker}</p> : null}
      {!state.on && !blocker && !confirming ? <p className="text-muted-foreground text-[13px]">{TURN_ON_CONSEQUENCE}</p> : null}
      <p className="text-muted-foreground text-[13px]">{BREAK_GLASS_NOTE}</p>
      <Tech>
        {`security.ssoOnly.set { on: ${state.on} } · requireSso · ready: ${state.ready.map((p) => `${p.providerId} (${p.protocol})`).join(', ') || 'none'} · break-glass audited as auth.breakGlass.signIn`}
      </Tech>
    </div>
  );
}
