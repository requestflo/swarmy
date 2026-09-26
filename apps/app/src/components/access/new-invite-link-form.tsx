import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Tech } from '@/components/calm';
import { AppChips } from '@/components/apikeys/app-chips';
import { IssuedSecretPanel } from '@/components/apikeys/issued-secret-panel';
import { FilterChip } from '@/components/blueprints/filter-chip';
import { Segmented } from '@/components/domains/segmented';
import {
  describeInviteLink,
  INVITE_EXPIRY_LABEL,
  INVITE_USES_MAX,
  type InviteExpiry,
  type InviteRole,
  type InviteUses,
} from './invite-words';

const EXPIRIES: InviteExpiry[] = ['1d', '7d', 'never'];
const USES: InviteUses[] = ['1', '10', 'unlimited'];

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[4.5rem_1fr] sm:items-center sm:gap-3">
      <span className="text-sm font-medium">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Mint a shareable link: role, one app or all, how long, how many people. The URL is shown once. */
export function NewInviteLinkForm(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [role, setRole] = React.useState<InviteRole>('member');
  const [apps, setApps] = React.useState<string[] | null>(null);
  const [expiry, setExpiry] = React.useState<InviteExpiry>('7d');
  const [uses, setUses] = React.useState<InviteUses>('10');
  const [url, setUrl] = React.useState<string | null>(null);
  const create = useMutation(
    trpc.inviteLinks.create.mutationOptions({
      onSuccess: (res) => {
        setUrl(res.url);
        void qc.invalidateQueries({ queryKey: trpc.inviteLinks.list.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const stackName = role === 'admin' ? null : (apps?.[0] ?? null);
  const maxUses = INVITE_USES_MAX[uses];

  if (url) {
    return (
      <div className="flex flex-col gap-3">
        <IssuedSecretPanel title="Copy the link now. It won’t be shown again." lines={[{ label: 'Invite link', value: url }]} />
        <Tech>swarmy keeps only a hash of the token, so this is the one time you can copy it.</Tech>
        <Button variant="outline" className="w-fit pointer-coarse:min-h-11" onClick={() => setUrl(null)}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate({ role, stackName, expiry, maxUses }); }}>
      <Field label="Joins as">
        <div role="group" aria-label="Joins as" className="flex flex-wrap gap-1.5">
          <FilterChip selected={role === 'member'} onClick={() => setRole('member')}>Member</FilterChip>
          <FilterChip selected={role === 'admin'} onClick={() => { setRole('admin'); setApps(null); }}>Admin</FilterChip>
        </div>
      </Field>
      <Field label="On">
        <AppChips value={stackName ? [stackName] : null} onChange={setApps} label="On" disabled={role === 'admin'} />
        {role === 'admin' ? <p className="text-muted-foreground mt-1 text-xs">An admin sees every app, so there’s no app to pick.</p> : null}
      </Field>
      <Field label="Expires">
        <Segmented mono label="Expires" value={expiry} onChange={setExpiry} options={EXPIRIES.map((e) => ({ value: e, label: INVITE_EXPIRY_LABEL[e] }))} />
      </Field>
      <Field label="Uses">
        <Segmented mono label="Uses" value={uses} onChange={setUses} options={USES.map((u) => ({ value: u, label: u }))} />
      </Field>
      <div className="bg-muted/50 rounded-[10px] border px-3.5 py-3" aria-live="polite">
        <p className="text-[13.5px] leading-snug">{describeInviteLink({ role, stackName, expiry, maxUses })}</p>
        <Tech>{`inviteLinks.create { role: ${role}, stackName: ${stackName ? JSON.stringify(stackName) : 'null'}, expiry: ${expiry}, maxUses: ${maxUses ?? 'null'} }`}</Tech>
      </div>
      <Button type="submit" variant="outline" className="w-fit pointer-coarse:min-h-11" disabled={create.isPending}>
        {create.isPending ? 'Creating…' : 'Create link'}
      </Button>
    </form>
  );
}
