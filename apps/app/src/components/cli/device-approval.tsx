import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckIcon, LaptopIcon, TerminalIcon, XIcon } from 'lucide-react';
import { Button, Card, CardContent, Input, Label, StatusBadge, Switch, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';

type Scope = 'read' | 'write' | 'secrets.read';

const SCOPE_COPY: Record<Scope, { label: string; hint: string }> = {
  read: { label: 'See everything', hint: 'Apps, services, logs and env (secret values stay hidden).' },
  write: { label: 'Deploy and change things', hint: 'Deploys, env changes, previews — your org’s policies still apply.' },
  'secrets.read': { label: 'Read secret values', hint: 'env pull --include-secrets. Every read is audited.' },
};

/** Confirm a `swarmy login` from the CLI: shows the code, the machine, and what it asks for. */
export function DeviceApproval({ initialCode }: { initialCode: string }): React.JSX.Element {
  const [code, setCode] = React.useState(initialCode);
  const [submitted, setSubmitted] = React.useState(initialCode);
  return (
    <div className="mx-auto w-full max-w-xl px-6 pt-10 pb-28 lg:pb-20">
      <span className="eyebrow">Sign in a device</span>
      <h1 className="headline mt-4 text-[2.2rem] sm:text-5xl/[3.6rem]">
        Let the <em>CLI</em> in?
      </h1>
      <p className="text-muted-foreground mt-3">
        Only approve if you just ran <span className="mono-data">swarmy login</span> and the code matches your terminal.
      </p>
      {submitted ? (
        <DeviceRequest code={submitted} onReset={() => setSubmitted('')} />
      ) : (
        <form
          className="card-pop mt-8 space-y-3 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(code.trim());
          }}
        >
          <Label htmlFor="device-code">Code from your terminal</Label>
          <Input
            id="device-code"
            autoFocus
            value={code}
            placeholder="BCDF-GHJK"
            className="mono-data text-lg tracking-widest uppercase"
            onChange={(e) => setCode(e.target.value)}
          />
          <Button type="submit" className="rounded-full font-bold" disabled={code.trim().length < 8}>
            Continue
          </Button>
        </form>
      )}
    </div>
  );
}

function DeviceRequest({ code, onReset }: { code: string; onReset: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const req = useQuery({ ...trpc.apiKeys.cliRequest.queryOptions({ userCode: code }), retry: false });
  const [scopes, setScopes] = React.useState<Scope[] | null>(null);
  const approve = useMutation(trpc.apiKeys.cliApprove.mutationOptions());
  const deny = useMutation(trpc.apiKeys.cliDeny.mutationOptions());

  if (req.isPending) return <CardSkeleton lines={4} className="mt-8" />;
  if (req.isError) {
    return (
      <div className="mt-8 space-y-4">
        <ErrorState title="No login waiting for that code." error="It may have expired (codes last 10 minutes). Run swarmy login again." />
        <Button variant="outline" className="rounded-full" onClick={onReset}>
          Enter another code
        </Button>
      </div>
    );
  }
  const r = req.data;
  const chosen = scopes ?? r.requestedScopes.filter((s) => r.grantableScopes.includes(s));
  const done = approve.isSuccess || deny.isSuccess || r.status !== 'pending';

  if (approve.isSuccess) {
    return (
      <Card className="card-pop mt-8">
        <CardContent className="flex items-start gap-4 p-6">
          <CheckIcon className="text-status-online mt-1 size-6 shrink-0" />
          <div>
            <p className="text-lg font-bold">You’re in. Head back to the terminal.</p>
            <p className="text-muted-foreground mt-1 text-sm">
              A key named “CLI · {r.hostname ?? r.clientName}” was created with {approve.data.scopes.join(', ')}. Revoke it any
              time in Settings → API keys.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (deny.isSuccess || r.status === 'denied') {
    return (
      <Card className="card-pop mt-8">
        <CardContent className="flex items-center gap-4 p-6">
          <XIcon className="text-status-offline size-6" />
          <p className="font-bold">Denied. The terminal will stop waiting.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="card-pop mt-8">
      <CardContent className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="ink-block flex size-10 items-center justify-center rounded-xl">
              {r.hostname ? <LaptopIcon className="size-5" /> : <TerminalIcon className="size-5" />}
            </span>
            <div>
              <p className="font-bold">{r.clientName}</p>
              <p className="mono-label text-muted-foreground">{r.hostname ?? 'unknown machine'}</p>
            </div>
          </div>
          <span className="mono-data rounded-lg border px-3 py-1 text-lg tracking-widest">{r.userCode}</span>
        </div>

        <fieldset className="space-y-3">
          <legend className="mono-label text-muted-foreground mb-2">It asks to</legend>
          {r.requestedScopes.map((s) => {
            const allowed = r.grantableScopes.includes(s);
            const locked = s === 'read';
            return (
              <label
                key={s}
                className={cn('flex items-start gap-3 rounded-xl border p-3', !allowed && 'opacity-60')}
              >
                <Switch
                  checked={chosen.includes(s)}
                  disabled={locked || !allowed || done}
                  onCheckedChange={(v) =>
                    setScopes(v ? [...new Set([...chosen, s])] : chosen.filter((x) => x !== s))
                  }
                />
                <span className="space-y-0.5">
                  <span className="flex items-center gap-2 font-semibold">
                    {SCOPE_COPY[s].label}
                    {!allowed && <StatusBadge tone="warning" label="admins only" />}
                  </span>
                  <span className="text-muted-foreground block text-sm">{SCOPE_COPY[s].hint}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {(approve.isError || deny.isError) && (
          <p className="text-status-offline text-sm" role="alert">
            {(approve.error ?? deny.error)?.message}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Button
            className="rounded-full font-bold shadow-[0_8px_24px_-8px_var(--primary)] hover:scale-[1.03]"
            disabled={done || approve.isPending}
            onClick={() => approve.mutate({ userCode: r.userCode, scopes: chosen })}
          >
            Approve
          </Button>
          <Button
            variant="outline"
            className="rounded-full"
            disabled={done || deny.isPending}
            onClick={() => deny.mutate({ userCode: r.userCode })}
          >
            Deny
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
