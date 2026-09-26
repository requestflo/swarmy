import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckIcon, LaptopIcon, TerminalIcon, XIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import type { ApiKeyScope } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { NextAction, Section, StatusWord, Tech } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { QuietSwitch } from '@/components/rowpage/row-page';

type Scope = ApiKeyScope;

const SCOPE_COPY: Record<Scope, { label: string; hint: string }> = {
  read: { label: 'See everything', hint: 'Apps, services, logs and variables (secret values stay hidden).' },
  deploy: { label: 'Ship and roll back', hint: 'Deploys and put-backs only. It can’t change variables, servers or people.' },
  write: { label: 'Deploy and change things', hint: 'Deploys, variable changes, previews. Your workspace rules still apply.' },
  'secrets.read': { label: 'Read secret values', hint: 'env pull --include-secrets. Every read is audited.' },
};

/** The request behind one code: which machine, what it asks for, approve or deny. */
export function DeviceRequest({ code, onReset }: { code: string; onReset: () => void }): React.JSX.Element {
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
        <Button variant="outline" className="pointer-coarse:min-h-11" onClick={onReset}>
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
      <Section title="You’re in. Head back to the terminal." className="mt-8" action={<CheckIcon aria-hidden className="text-tone-ok size-5" />}>
          <div>
            <p className="text-muted-foreground text-sm">
              A key named “CLI · {r.hostname ?? r.clientName}” was created with {approve.data.scopes.join(', ')}. Revoke it any
              time in Settings → API, CLI &amp; MCP.
            </p>
          </div>
      </Section>
    );
  }
  if (deny.isSuccess || r.status === 'denied') {
    return (
      <Section title="Denied. The terminal will stop waiting." className="mt-8" action={<XIcon aria-hidden className="text-tone-bad size-5" />}>
        <p className="text-muted-foreground text-sm">Nothing was created.</p>
      </Section>
    );
  }

  return (
    <NextAction eyebrow="Waiting for you" className="mt-8" tone="info" title={`${r.clientName} wants to sign in as you.`} tech={`client ${r.clientName} · requested ${r.requestedScopes.join(',')} · you may grant ${r.grantableScopes.join(',')}`}>
      <div className="space-y-5 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="bg-surface-2 dark:bg-accent flex size-10 items-center justify-center rounded-xl">
              {r.hostname ? <LaptopIcon className="size-5" /> : <TerminalIcon className="size-5" />}
            </span>
            <div>
              <p className="text-foreground font-semibold">{r.hostname ?? 'an unnamed machine'}</p>
              <p className="text-muted-foreground text-xs">Check the code matches your terminal</p>
            </div>
          </div>
          <span className="text-foreground rounded-lg border px-3 py-1 font-mono text-lg tracking-widest">{r.userCode}</span>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-foreground mb-2 text-sm font-semibold">It asks to</legend>
          {r.requestedScopes.map((s) => {
            const allowed = r.grantableScopes.includes(s);
            const locked = s === 'read';
            return (
              <label
                key={s}
                className={cn('border-border flex items-start gap-3 rounded-xl border p-3', !allowed && 'opacity-70')}
              >
                <QuietSwitch
                  aria-label={SCOPE_COPY[s].label}
                  checked={chosen.includes(s)}
                  disabled={locked || !allowed || done}
                  onCheckedChange={(v) =>
                    setScopes(v ? [...new Set([...chosen, s])] : chosen.filter((x) => x !== s))
                  }
                />
                <span className="space-y-0.5">
                  <span className="text-foreground flex items-center gap-2 font-semibold">
                    {SCOPE_COPY[s].label}
                    {!allowed && <StatusWord tone="warn" word="admins only" />}
                  </span>
                  <span className="text-muted-foreground block text-sm">{SCOPE_COPY[s].hint}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {(approve.isError || deny.isError) && (
          <p className="text-tone-bad text-sm" role="alert">
            {(approve.error ?? deny.error)?.message}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Button
            className="pointer-coarse:min-h-11"
            disabled={done || approve.isPending}
            onClick={() => approve.mutate({ userCode: r.userCode, scopes: chosen })}
          >
            Approve
          </Button>
          <Button
            variant="outline"
            className="pointer-coarse:min-h-11"
            disabled={done || deny.isPending}
            onClick={() => deny.mutate({ userCode: r.userCode })}
          >
            Deny
          </Button>
        </div>
        <Tech>approving mints an API key named “CLI · machine” with the scopes you leave on</Tech>
      </div>
    </NextAction>
  );
}
