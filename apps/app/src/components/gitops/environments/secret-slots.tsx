import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, toast } from '@swarmy/ui';
import { StatusWord, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { SecretSlot } from '../gitops-types';
import { slotReaders } from './clone-model';

/**
 * A cloned environment's secrets (board Environments: "create secret
 * stripe-key for qa · secrets are never copied"): one write-only field per
 * slot. The value goes straight into this environment's own Docker secret
 * (`apps.setEnvironmentSecret`) and never comes back; setting it again rotates it.
 */
export function SecretSlots({ stack, env, slots }: { stack: string; env: string; slots: SecretSlot[] }): React.JSX.Element {
  if (slots.length === 0) {
    return <p className="text-muted-foreground text-[13px]">swarmy.yaml names no secrets, so {env} has none to fill.</p>;
  }
  return (
    <ul aria-label={`Secrets for ${env}`} className="flex flex-col gap-3">
      {slots.map((s) => (
        <SlotRow key={s.family} stack={stack} env={env} slot={s} />
      ))}
    </ul>
  );
}

function SlotRow({ stack, env, slot }: { stack: string; env: string; slot: SecretSlot }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [value, setValue] = React.useState('');
  const [done, setDone] = React.useState<number | null>(null);
  const set = useMutation(
    trpc.apps.setEnvironmentSecret.mutationOptions({
      onSuccess: (r) => {
        setValue('');
        setDone(r.version);
        toast.success(`${slot.family} is set for ${env}`);
        void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const filled = slot.filled || done !== null;
  const id = React.useId();
  return (
    <li className="border-border flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-semibold">{slot.family}</span>
        <span className="text-muted-foreground text-xs">for {env} · secrets are never copied</span>
        <span className="ml-auto">
          <StatusWord tone={filled ? 'ok' : 'warn'} word={filled ? 'Set' : 'Empty'} />
        </span>
      </div>
      {filled ? (
        <p className="text-muted-foreground text-xs">
          {slot.family} set for {env} · ••• · write-only{done !== null ? ` · v${done}` : ''}
        </p>
      ) : null}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) set.mutate({ stack, family: slot.family, value });
        }}
      >
        <label htmlFor={id} className="sr-only">{`Value of ${slot.family} for ${env}`}</label>
        <Input id={id} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder={filled ? 'Paste a new value to replace it' : 'Paste the value'} className="h-9 min-w-0 flex-1 font-mono text-[12.5px]" />
        <Button type="submit" size="sm" variant={filled ? 'outline' : 'default'} disabled={!value || set.isPending} className="pointer-coarse:min-h-11">
          {set.isPending ? 'Saving…' : filled ? 'Replace' : 'Create'}
        </Button>
      </form>
      <Tech>{`${slot.envFamily} · ${slotReaders(slot)}`}</Tech>
    </li>
  );
}
