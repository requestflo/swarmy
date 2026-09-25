import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon, TerminalIcon } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  CopyButton,
  EmptyState,
  Input,
  Label,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { NODE_PROFILE_LABELS, NODE_PROFILE_VALUES, type NodeProfile } from '@swarmy/core';
import {
  ControllerUrlWarning,
  installOneLiner,
  type InstallTarget,
  type MeshSetupKey,
} from '@/components/onboarding/install-command-panel';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';


function tokenTone(status: string): React.ComponentProps<typeof StatusBadge>['tone'] {
  return status === 'active' ? 'online' : 'neutral';
}

/** Navy statement panel shown once, right after a token is minted. */
function IssuedTokenPanel({
  token,
  mesh,
  target,
}: {
  token: string;
  mesh: MeshSetupKey | null;
  target: InstallTarget | null;
}): React.JSX.Element {
  const oneLiner = installOneLiner(token, '', 'auto', mesh, target);
  return (
    <Alert className="ink-block border-0">
      <KeyRoundIcon className="size-4" />
      <AlertTitle className="font-bold">Copy it now — this token won&apos;t be shown again.</AlertTitle>
      <AlertDescription className="text-ink-foreground/70">
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
            {token}
          </code>
          <CopyButton value={token} label="Copy" />
        </div>
        <p className="mt-4 mb-1 text-xs font-medium">Run this on any fresh Linux box:</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
            {oneLiner}
          </code>
          <CopyButton value={oneLiner} label="Copy" />
        </div>
        <ControllerUrlWarning target={target} className="mt-2" />
      </AlertDescription>
    </Alert>
  );
}

/** Mint + manage node join tokens. */
export function TokensTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const tokens = useQuery(trpc.nodes.listJoinTokens.queryOptions());
  const [issued, setIssued] = React.useState<{
    token: string;
    mesh: MeshSetupKey | null;
    target: InstallTarget | null;
  } | null>(null);
  const [label, setLabel] = React.useState('');
  const [profile, setProfile] = React.useState<NodeProfile>('default');

  const generate = useMutation(
    trpc.nodes.generateJoinToken.mutationOptions({
      onSuccess: (res) => {
        setIssued({
          token: res.token,
          mesh: res.meshSetupKey
            ? { setupKey: res.meshSetupKey, managementUrl: res.meshManagementUrl, driver: res.meshDriver }
            : null,
          target: res.install ?? null,
        });
        setLabel('');
        setProfile('default');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const revoke = useMutation(
    trpc.nodes.revokeJoinToken.mutationOptions({
      onSuccess: () => {
        toast.success('Token revoked');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = tokens.data ?? [];

  return (
    <div className="grid gap-6">
      <div className="border-border grid gap-4 rounded-xl border p-4">
          <p className="text-muted-foreground text-sm">
            The easy way is{' '}
            <Link to="/nodes/new" className="text-foreground font-semibold underline underline-offset-2">
              Add a server
            </Link>
            : copy one line, paste it, watch it connect. Or make a raw join token here.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-[12rem] flex-1 gap-1.5">
              <Label htmlFor="token-label">
                Name (optional)
              </Label>
              <Input
                id="token-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="prod-worker-1"
              />
            </div>
            <div className="grid min-w-[11rem] gap-1.5">
              <Label htmlFor="token-profile">
                Profile
              </Label>
              <select
                id="token-profile"
                value={profile}
                onChange={(e) => setProfile(e.target.value as NodeProfile)}
                title={NODE_PROFILE_LABELS[profile].description}
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              >
                {NODE_PROFILE_VALUES.map((p) => (
                  <option key={p} value={p}>
                    {NODE_PROFILE_LABELS[p].title}
                  </option>
                ))}
              </select>
            </div>
            <Button
              variant="outline"
              onClick={() =>
                generate.mutate({
                  label: label || undefined,
                  profile: profile === 'default' ? undefined : profile,
                })
              }
              disabled={generate.isPending}
            >
              <PlusIcon className="size-4" /> Make a token
            </Button>
          </div>
          <p className="text-muted-foreground -mt-2 text-xs">{NODE_PROFILE_LABELS[profile].description}</p>
      </div>

      {issued && <IssuedTokenPanel token={issued.token} mesh={issued.mesh} target={issued.target} />}

      <div>
        {rows.length === 0 ? (
          <EmptyState
            className="border-0 py-14"
            icon={<KeyRoundIcon />}
            title="No join tokens yet"
            description="Mint one above to bring your first node into the swarm."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/nodes/new">
                  <TerminalIcon className="size-4" /> Guided enroll
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="divide-border divide-y">
            {rows.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1 py-3"
              >
                <div className="min-w-[10rem] flex-1">
                  <p className="truncate font-medium">
                    {t.label ?? 'Unlabelled token'}
                    {t.profile ? (
                      <span className="text-muted-foreground ml-2 text-xs font-normal">
                        {NODE_PROFILE_LABELS[t.profile].title}
                      </span>
                    ) : null}
                  </p>
                  <p className="mono-data text-muted-foreground text-xs">{t.tokenPrefix}…</p>
                </div>
                <div className="hidden sm:block">
                  <p className="mono-label">Uses</p>
                  <p className="mono-data text-sm">
                    {t.usedCount}
                    {t.maxUses != null ? ` / ${t.maxUses}` : ''}
                  </p>
                </div>
                <div className="hidden sm:block">
                  <p className="mono-label">Created</p>
                  <p className="mono-data text-muted-foreground text-sm">{relTime(t.createdAt)}</p>
                </div>
                <StatusBadge tone={tokenTone(t.status)} label={t.status} />
                <div className="ml-auto">
                  {t.status === 'active' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate({ id: t.id })}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
