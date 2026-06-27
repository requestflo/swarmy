import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon, TerminalIcon } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CopyButton,
  EmptyState,
  Input,
  Label,
  StatusBadge,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';

function installOneLiner(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `curl -fsSL ${origin}/install.sh | SWARMY_JOIN_TOKEN=${token} sh`;
}

function tokenTone(status: string): React.ComponentProps<typeof StatusBadge>['tone'] {
  return status === 'active' ? 'online' : 'neutral';
}

/** Navy statement panel shown once, right after a token is minted. */
function IssuedTokenPanel({ token }: { token: string }): React.JSX.Element {
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
            {installOneLiner(token)}
          </code>
          <CopyButton value={installOneLiner(token)} label="Copy" />
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Mint + manage node join tokens. */
export function TokensTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const tokens = useQuery(trpc.nodes.listJoinTokens.queryOptions());
  const [issued, setIssued] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('');

  const generate = useMutation(
    trpc.nodes.generateJoinToken.mutationOptions({
      onSuccess: (res) => {
        setIssued(res.token);
        setLabel('');
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
      <Card className="card-pop border-0">
        <CardContent className="grid gap-4 p-5">
          <div>
            <h2 className="font-display text-lg font-semibold">Enroll a node</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              The fastest way is the{' '}
              <Link to="/nodes/new" className="text-primary font-medium underline-offset-2 hover:underline">
                guided one-liner
              </Link>{' '}
              — copy, paste, watch it connect. Or mint a raw join token below.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-[12rem] flex-1 gap-1.5">
              <Label htmlFor="token-label" className="mono-label">
                Label (optional)
              </Label>
              <Input
                id="token-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="prod-worker-1"
              />
            </div>
            <Button
              onClick={() => generate.mutate({ label: label || undefined })}
              disabled={generate.isPending}
            >
              <PlusIcon className="size-4" /> Generate token
            </Button>
          </div>
        </CardContent>
      </Card>

      {issued && <IssuedTokenPanel token={issued} />}

      <Card className={cn('card-pop border-0', rows.length > 0 && 'p-0')}>
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
                className="hover:bg-accent/50 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors"
              >
                <div className="min-w-[10rem] flex-1">
                  <p className="truncate font-medium">{t.label ?? 'Unlabelled token'}</p>
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
      </Card>
    </div>
  );
}
