import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Label, Skeleton, toast } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';

const MIN = 60_000;

interface Draft {
  requireMfa: boolean;
  mfaMinutes: number;
  idleMinutes: number;
  maxMinutes: number;
}

/** Terminal policy knobs the controller enforces: step-up MFA, idle timeout, max length. */
export function TerminalPolicyCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policy = useQuery(trpc.terminal.policy.get.queryOptions());
  const [draft, setDraft] = React.useState<Draft | null>(null);
  React.useEffect(() => {
    const p = policy.data;
    if (p)
      setDraft({
        requireMfa: p.requireMfa,
        mfaMinutes: Math.round(p.mfaMaxAgeMs / MIN),
        idleMinutes: Math.round(p.idleTimeoutMs / MIN),
        maxMinutes: Math.round(p.maxSessionMs / MIN),
      });
  }, [policy.data]);
  const save = useMutation(
    trpc.terminal.policy.set.mutationOptions({
      onSuccess: () => {
        toast.success('Terminal policy saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const num = (key: keyof Draft, label: string, min: number, max: number): React.JSX.Element => (
    <div className="space-y-1.5">
      <Label htmlFor={`tp-${key}`}>{label}</Label>
      <Input
        id={`tp-${key}`}
        type="number"
        min={min}
        max={max}
        value={draft ? Number(draft[key]) : 0}
        onChange={(e) => draft && setDraft({ ...draft, [key]: Number(e.target.value) })}
      />
    </div>
  );

  return (
    <Section title="Terminal">
        {!draft ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <form
            className="grid gap-4 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({
                requireMfa: draft.requireMfa,
                mfaMaxAgeMs: draft.mfaMinutes * MIN,
                idleTimeoutMs: draft.idleMinutes * MIN,
                maxSessionMs: draft.maxMinutes * MIN,
              });
            }}
          >
            <label className="flex items-start gap-3 text-sm sm:col-span-3">
              <QuietSwitch checked={draft.requireMfa} onCheckedChange={(v) => setDraft({ ...draft, requireMfa: v })} />
              <span>
                Require recent MFA to open a shell
                <span className="text-muted-foreground block">
                  Off by default. When on, container exec and host shells ask password accounts with an authenticator
                  for a code unless one was entered recently. SSO and social sign-ins are never asked.
                </span>
              </span>
            </label>
            {num('mfaMinutes', 'MFA valid for (min)', 1, 720)}
            {num('idleMinutes', 'Idle timeout (min)', 1, 1440)}
            {num('maxMinutes', 'Max session length (min)', 5, 1440)}
            <div className="sm:col-span-3">
              <Button variant="outline" type="submit" disabled={save.isPending}>
                Save
              </Button>
            </div>
          </form>
        )}
      </Section>
  );
}
