import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GuardrailsConfigView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { NextAction, Section, StatusWord, Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';

function useSetMode() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return useMutation(
    trpc.guardrails.setSafetyMode.mutationOptions({
      onSuccess: (next) => {
        toast.success(next.productionSafetyMode ? 'Production is locked down: every rule blocks there.' : 'Safety mode off: each rule’s own level applies.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
}

/** When production isn't locked down, locking it is the page's one next action. */
export function SafetyModeNext({ config }: { config: GuardrailsConfigView }): React.JSX.Element | null {
  const setMode = useSetMode();
  if (config.productionSafetyMode) return null;
  return (
    <NextAction
      title="Lock production down."
      tech="guardrails.setSafetyMode · every rule enforced at block on apps labelled swarmy.env=production"
      actions={<Button className="pointer-coarse:min-h-11" disabled={setMode.isPending} onClick={() => setMode.mutate({ enabled: true })}>Turn on safety mode</Button>}
    >
      One switch: every guardrail blocks on production apps, whatever its own level. Everything else keeps its own settings.
    </NextAction>
  );
}

/** The production safety switch. */
export function SafetyModeCard({ config }: { config: GuardrailsConfigView }): React.JSX.Element {
  const setMode = useSetMode();
  const on = config.productionSafetyMode;
  return (
    <Section title="Production safety mode" action={<StatusWord tone={on ? 'ok' : 'idle'} word={on ? 'On' : 'Off'} />}>
      <label className="flex items-start gap-3 text-sm">
        <QuietSwitch checked={on} disabled={setMode.isPending} onCheckedChange={(v) => setMode.mutate({ enabled: v })} aria-label="Production safety mode" />
        <span className="text-muted-foreground">When on, every rule below blocks on production apps. Per-rule levels still govern everything else.</span>
      </label>
      <Tech>productionSafetyMode · production = the swarmy.env=production label</Tech>
    </Section>
  );
}
