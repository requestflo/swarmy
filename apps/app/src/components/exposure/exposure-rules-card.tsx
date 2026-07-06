import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExposureRulesView } from '@swarmy/core';

type RulesWithIntent = ExposureRulesView & { enforceDeclaredIntent: boolean };
import { Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** One rule toggle row: name, plain-English description, switch. */
function RuleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 px-5 py-3.5">
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="text-muted-foreground block text-xs">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
    </label>
  );
}

/** The exposure rules card: three toggles + the "Block violating deploys" switch. */
export function ExposureRulesCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const rules = useQuery(trpc.exposure.rules.queryOptions());
  const setRules = useMutation(
    trpc.exposure.setRules.mutationOptions({
      onSuccess: () => {
        toast.success('Exposure rules updated');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const r: RulesWithIntent | undefined = rules.data;
  const busy = rules.isLoading || setRules.isPending;
  const set = (patch: Partial<RulesWithIntent>): void => setRules.mutate(patch);

  return (
    <section className="card-pop overflow-hidden">
      <header className="border-border border-b px-5 py-3">
        <span className="mono-label !mb-0">Rules</span>
        <p className="text-muted-foreground text-xs">
          What swarmy checks at every deploy and on its 5-minute audit sweep.
        </p>
      </header>
      {rules.isLoading ? (
        <div className="space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-10 rounded-lg" />
          ))}
        </div>
      ) : rules.isError ? (
        <p className="text-muted-foreground px-5 py-4 text-sm">{rules.error.message}</p>
      ) : r ? (
        <>
          <div className="divide-border divide-y">
            <RuleRow
              label="No public ports on managed data"
              description="Databases, caches, search and vector stores must never publish a port — apps reach them over private networking."
              checked={r.noPublicPortsOnManagedData}
              onChange={(v) => set({ noPublicPortsOnManagedData: v })}
              disabled={busy}
            />
            <RuleRow
              label="No public UDP"
              description="Published UDP ports are refused unless a deploy explicitly overrides (your approval trail)."
              checked={r.noPublicUdp}
              onChange={(v) => set({ noPublicUdp: v })}
              disabled={busy}
            />
            <RuleRow
              label="Warn on new published ports"
              description="Any port a deploy would newly publish to the world gets flagged before it ships."
              checked={r.warnOnNewPublishedPorts}
              onChange={(v) => set({ warnOnNewPublishedPorts: v })}
              disabled={busy}
            />
            <RuleRow
              label="Enforce declared modes"
              description="A deploy contradicting its own swarmy.expose declaration (private/mesh with a public surface, tunnel with a published port) is refused — only services that declare a mode are checked."
              checked={r.enforceDeclaredIntent}
              onChange={(v) => set({ enforceDeclaredIntent: v })}
              disabled={busy}
            />
          </div>
          <div className="border-border bg-accent/40 border-t px-5 py-3.5">
            <label className="flex cursor-pointer items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-bold">Block violating deploys</span>
                <span className="text-muted-foreground block text-xs">
                  Off = advisory: violations show here and raise alerts, but deploys go through.
                </span>
              </span>
              <Switch
                checked={r.enforce}
                onCheckedChange={(v) => set({ enforce: v })}
                disabled={busy}
                className="mt-0.5"
              />
            </label>
          </div>
        </>
      ) : null}
    </section>
  );
}
