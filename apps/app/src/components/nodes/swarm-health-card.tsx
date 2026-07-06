import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CrownIcon, KeyRoundIcon, LockIcon, RefreshCwIcon, ShieldCheckIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyButton,
  StatusBadge,
  type StatusTone,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const VERDICT_TONE: Record<string, StatusTone> = {
  healthy: 'online',
  'at-risk': 'warning',
  'single-manager': 'warning',
  lost: 'offline',
  'no-swarm': 'neutral',
};

const VERDICT_LABEL: Record<string, string> = {
  healthy: 'quorum healthy',
  'at-risk': 'quorum at risk',
  'single-manager': 'single manager',
  lost: 'quorum lost',
  'no-swarm': 'no swarm',
};

/**
 * Swarm health (WS2) — manager census + quorum verdict, manager autolock with
 * the store-key/self-store choice, and join-token rotation. Admin-only: the
 * whole `swarm` router requires admin, so the card hides itself on FORBIDDEN.
 */
export function SwarmHealthCard(): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const health = useQuery({
    ...trpc.swarm.health.queryOptions(),
    refetchInterval: 5_000,
    retry: false,
  });

  // Key material shown at most once per action, never cached in the query layer.
  const [oneTimeKey, setOneTimeKey] = React.useState<string | null>(null);
  const [revealedKey, setRevealedKey] = React.useState<string | null>(null);

  const invalidate = (): void => void qc.invalidateQueries();

  const setAutolock = useMutation(
    trpc.swarm.setAutolock.mutationOptions({
      onSuccess: (r) => {
        if (r.unlockKey) {
          setOneTimeKey(r.unlockKey);
          toast.success('Autolock enabled — copy the unlock key now, it will not be shown again');
        } else {
          setOneTimeKey(null);
          toast.success(r.enabled ? 'Autolock enabled' : 'Autolock disabled');
        }
        setRevealedKey(null);
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const revealKey = useMutation(
    trpc.swarm.revealUnlockKey.mutationOptions({
      onSuccess: (r) => setRevealedKey(r.unlockKey),
      onError: (e) => toast.error(e.message),
    }),
  );
  const rotateTokens = useMutation(
    trpc.swarm.rotateJoinTokens.mutationOptions({
      onSuccess: () => {
        toast.success('Join tokens rotated — old tokens no longer admit nodes');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  // Members get FORBIDDEN — this card is for operators only.
  if (health.isError) return null;
  const h = health.data;
  if (!h) return null;

  const tone = VERDICT_TONE[h.managers.verdict] ?? 'neutral';

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheckIcon className="text-primary size-4" /> Swarm health
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-border grid gap-5 divide-y">
        {/* Manager census + quorum verdict */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <span className="mono-data text-lg">
                {h.managers.reachable} / {h.managers.total}
              </span>
              <span className="text-muted-foreground text-sm">
                manager{h.managers.total === 1 ? '' : 's'} reachable
              </span>
              <StatusBadge tone={tone} label={VERDICT_LABEL[h.managers.verdict] ?? h.managers.verdict} />
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{h.managers.message}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {h.managerNodes.map((m) => (
              <span
                key={m.hostname}
                className="mono-label border-border inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1"
              >
                {m.leader ? <CrownIcon className="text-primary size-3" /> : null}
                {m.hostname}
                <span
                  className={
                    m.reachable ? 'bg-status-online size-1.5 rounded-full' : 'bg-status-offline size-1.5 rounded-full'
                  }
                />
              </span>
            ))}
          </div>
        </div>

        {/* Autolock */}
        <div className="pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                <LockIcon className="size-4" /> Manager autolock
                {h.autolock.keyStored ? (
                  <StatusBadge tone="online" label="unlock key stored" />
                ) : null}
                {h.autolock.lockedNodes > 0 ? (
                  <StatusBadge tone="warning" label={`${h.autolock.lockedNodes} locked`} />
                ) : null}
              </div>
              <p className="text-muted-foreground mt-1 text-sm">
                Encrypts the raft state at rest — a restarted manager stays locked until the unlock
                key is presented.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={setAutolock.isPending}>
                    Enable
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Enable manager autolock?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Docker mints an unlock key. swarmy can store it encrypted (recommended — it is
                      revealed to admins on demand, audited), or show it to you exactly once and
                      store nothing.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => setAutolock.mutate({ enabled: true, storeKey: false })}
                    >
                      Enable, I'll store the key
                    </AlertDialogAction>
                    <AlertDialogAction onClick={() => setAutolock.mutate({ enabled: true })}>
                      Enable &amp; store key
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button
                variant="outline"
                disabled={setAutolock.isPending}
                onClick={() => setAutolock.mutate({ enabled: false })}
              >
                Disable
              </Button>
              {h.autolock.keyStored ? (
                <Button
                  variant="outline"
                  disabled={revealKey.isPending}
                  onClick={() => (revealedKey ? setRevealedKey(null) : revealKey.mutate())}
                >
                  <KeyRoundIcon className="size-4" /> {revealedKey ? 'Hide key' : 'Reveal key'}
                </Button>
              ) : null}
            </div>
          </div>

          {oneTimeKey ? (
            <div className="bg-accent mt-3 flex items-center justify-between gap-3 rounded-xl px-3 py-2">
              <div className="min-w-0">
                <p className="text-status-warning text-xs font-medium">
                  Shown once — swarmy stored nothing. Keep it somewhere safe.
                </p>
                <p className="mono-data truncate text-sm">{oneTimeKey}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <CopyButton value={oneTimeKey} />
                <Button variant="outline" size="sm" onClick={() => setOneTimeKey(null)}>
                  Done
                </Button>
              </div>
            </div>
          ) : null}

          {revealedKey ? (
            <div className="bg-accent mt-3 flex items-center justify-between gap-3 rounded-xl px-3 py-2">
              <p className="mono-data min-w-0 truncate text-sm">{revealedKey}</p>
              <CopyButton value={revealedKey} className="shrink-0" />
            </div>
          ) : null}
        </div>

        {/* Join-token rotation */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-5">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <RefreshCwIcon className="size-4" /> Join tokens
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              Rotate the worker + manager join tokens if one may have leaked. Enrolled nodes are
              unaffected; swarmy re-stores the fresh tokens for future joins.
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={rotateTokens.isPending}>
                Rotate tokens
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Rotate the swarm join tokens?</AlertDialogTitle>
                <AlertDialogDescription>
                  Both tokens are re-minted on the manager and stored encrypted. Anything holding
                  the old tokens can no longer join this swarm.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => rotateTokens.mutate(undefined)}>
                  Rotate both tokens
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
