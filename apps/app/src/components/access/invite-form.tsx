import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon } from 'lucide-react';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Depth } from '@/components/calm';
import { AppChips } from '@/components/apikeys/app-chips';
import { Segmented } from '@/components/domains/segmented';
import type { IssuedInvite } from '@/components/settings/invite-link-panel';
import { InvitePreview } from './invite-preview';
import type { RoleKey } from './role-lines';
import { SsoAcceptChoice, useSsoInviteOption } from './sso-accept-choice';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_PICK: Record<RoleKey, { label: string; hint: string }> = {
  member: { label: 'Member', hint: 'the rules decide' },
  admin: { label: 'Admin', hint: 'runs everything' },
  owner: { label: 'Owner', hint: 'adds owners too' },
};

function RolePick({ role }: { role: RoleKey }): React.JSX.Element {
  return (
    <span className="flex flex-col items-start py-1 leading-tight">
      <span>{ROLE_PICK[role].label}</span>
      <span className="text-muted-foreground text-[10.5px] font-normal">{ROLE_PICK[role].hint}</span>
    </span>
  );
}

/** Email (optional), role, one app or all — with what that lets them do, live from the org's rules. */
export function InviteForm({ callerRole, onIssued }: { callerRole: RoleKey; onIssued: (i: IssuedInvite) => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<RoleKey>('member');
  const [apps, setApps] = React.useState<string[] | null>(null);
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [sso, setSso] = React.useState(false);
  const { requireSso } = useSsoInviteOption(sso);
  const stackName = role === 'member' ? (apps?.[0] ?? null) : null;
  const invite = useMutation(
    trpc.members.invite.mutationOptions({
      onSuccess: (res) => {
        onIssued({ email: res.email, role: res.role, link: res.link, expiresAt: res.expiresAt });
        toast.success(res.emailed ? `Invite emailed to ${res.email} and added to the audit log` : 'Invite link ready');
        void qc.invalidateQueries({ queryKey: trpc.members.listInvitations.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const roles: RoleKey[] = callerRole === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin'];
  const input = { email: email.trim() || null, role, stackName, requireSso };

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    if (input.email && !EMAIL_RE.test(input.email)) return setEmailError('That does not look like an email address.');
    invite.mutate(input);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-1.5">
        <Label htmlFor="invite-email" className="text-[12.5px] font-semibold">
          Email <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id="invite-email"
          type="email"
          autoFocus
          className="font-mono text-[13px]"
          value={email}
          aria-invalid={emailError ? true : undefined}
          onChange={(e) => {
            setEmail(e.target.value);
            setEmailError(null);
          }}
          placeholder="sam@example.com"
        />
        {emailError ? <p className="text-tone-bad text-xs font-medium">{emailError}</p> : null}
        <p className="text-muted-foreground text-xs">Blank makes a link anyone holding it can use. With an email, only that address can.</p>
      </div>
      <div className="grid gap-1.5">
        <span className="text-[12.5px] font-semibold">Role</span>
        <Segmented label="Role" value={role} onChange={setRole} options={roles.map((r) => ({ value: r, label: <RolePick role={r} /> }))} />
      </div>
      <div className="grid gap-1.5">
        <span className="text-[12.5px] font-semibold">Which apps</span>
        <AppChips value={stackName ? [stackName] : null} onChange={setApps} label="Which apps" disabled={role !== 'member'} />
        <p className="text-muted-foreground text-xs">
          {role === 'member' ? 'Picking an app makes them its operator, production included.' : 'Admins and owners always reach every app.'}
        </p>
      </div>
      <SsoAcceptChoice value={sso} onChange={setSso} email={Boolean(input.email)} />
      <div className="border-t pt-3">
        <InvitePreview role={role} stackName={stackName} />
      </div>
      <Depth at="code">
        <pre className="calm-code overflow-x-auto rounded-[10px] px-3 py-2.5 text-[11px] leading-relaxed">
          {`policies.simulateInvite ${JSON.stringify({ role, stackNames: stackName ? [stackName] : [] })}\nmembers.invite ${JSON.stringify(input)}`}
        </pre>
      </Depth>
      <Button type="submit" className="w-fit pointer-coarse:min-h-11" disabled={invite.isPending}>
        {invite.isPending ? <Loader2Icon className="animate-spin" /> : null}
        Create invite
      </Button>
    </form>
  );
}
