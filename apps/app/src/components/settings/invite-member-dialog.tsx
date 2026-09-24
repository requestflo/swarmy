import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon, UserPlusIcon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { InviteLinkPanel, type IssuedInvite } from './invite-link-panel';

type InviteRole = 'owner' | 'admin' | 'member';

const ROLE_HELP: Record<InviteRole, string> = {
  member: 'Can deploy and operate what policies allow.',
  admin: 'Everything a member can, plus governance, tokens and invites.',
  owner: 'Full control, including other owners.',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invite someone by minting a one-shot link they open to join this org. */
export function InviteMemberDialog({ callerRole }: { callerRole: InviteRole }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<InviteRole>('member');
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [issued, setIssued] = React.useState<IssuedInvite | null>(null);

  const invite = useMutation(
    trpc.members.invite.mutationOptions({
      onSuccess: (res) => {
        setIssued({ email: res.email, role: res.role, link: res.link, expiresAt: res.expiresAt });
        toast.success(res.email ? `Invite link ready for ${res.email}` : 'Invite link ready');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  function reset(): void {
    setEmail('');
    setRole('member');
    setEmailError(null);
    setIssued(null);
  }

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = email.trim();
    // Email is optional: without one the link alone admits whoever opens it.
    if (trimmed && !EMAIL_RE.test(trimmed)) return setEmailError('That does not look like an email address.');
    setEmailError(null);
    invite.mutate({ email: trimmed || null, role });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UserPlusIcon className="size-4" /> Invite member
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">{issued ? 'Link ready.' : 'Invite a teammate'}</DialogTitle>
          <DialogDescription>
            {issued
              ? 'This controller sends no email — you carry the link.'
              : 'Mint a one-shot link. Send it however you like; there is no mailer to configure.'}
          </DialogDescription>
        </DialogHeader>

        {issued ? (
          <>
            <InviteLinkPanel invite={issued} />
            <DialogFooter>
              <Button variant="outline" onClick={() => reset()}>
                Invite another
              </Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="grid gap-4" noValidate>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-email" className="mono-label">
                Email <span className="text-muted-foreground font-normal normal-case">(optional)</span>
              </Label>
              <Input
                id="invite-email"
                type="email"
                autoFocus
                value={email}
                aria-invalid={emailError ? true : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
                placeholder="teammate@example.com"
              />
              <p className="text-muted-foreground text-xs">
                Blank: a plain link anyone holding it can use (SSO, social or a new username). With an email: only a
                sign-in proving that address (SSO/social with it, or a verified email) can redeem it.
              </p>
              {emailError && <p className="text-status-offline text-xs font-medium">{emailError}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-role" className="mono-label">
                Role
              </Label>
              <Select value={role} onValueChange={(v) => setRole(v as InviteRole)}>
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  {callerRole === 'owner' && <SelectItem value="owner">Owner</SelectItem>}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">{ROLE_HELP[role]}</p>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending && <Loader2Icon className="animate-spin" />}
                Create invite link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
