import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CacheEvictionPolicy, CachePersistence } from '@swarmy/core';
import { cn, toast } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { Kv } from './cache-kv';
import type { CacheView } from './cache-words';
import {
  EVICTION_CHOICES,
  PERSISTENCE_CHOICES,
  applyingWords,
  evictionDisabled,
  evictionWords,
  persistenceWords,
  policyOf,
  type PolicyChoice,
} from './cache-policy-words';

/** A row of choice buttons at Controls (the memory-limit picker's shape). */
function Picker<T extends string>(props: {
  label: string;
  choices: PolicyChoice<T>[];
  value: T;
  busy: boolean;
  disabled?: (c: T) => string | null;
  onPick: (c: T) => void;
}): React.JSX.Element {
  return (
    <div role="group" aria-label={props.label} className="flex flex-wrap gap-1">
      {props.choices.map((c) => {
        const why = props.disabled?.(c.value) ?? null;
        return (
          <button
            key={c.value}
            type="button"
            aria-pressed={c.value === props.value}
            title={why ?? c.tech}
            disabled={props.busy || Boolean(why)}
            onClick={() => c.value !== props.value && props.onPick(c.value)}
            className={cn(
              'min-h-9 rounded-lg border px-2.5 text-[12.5px] disabled:opacity-50 pointer-coarse:min-h-11',
              c.value === props.value ? 'bg-muted border-foreground/30 font-semibold' : 'hover:bg-muted/50',
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * "When full" and "Persistence": a sentence at Summary, pickers at Controls
 * (`cache.setPolicy`). cache-reconcile applies a change to the running copies;
 * until it has, the row says so.
 */
export function CachePolicyRows({ v }: { v: CacheView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.cache.setPolicy.mutationOptions({
      onSuccess: () => {
        toast.success(`${v.name} · saved, being applied to its running copies`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const policy = policyOf(v);
  const evict = evictionWords(v);
  const keep = persistenceWords(v);
  const applying = applyingWords(v);
  const ref = { stack: v.stack, cluster: v.name };
  const note = applying ? <span className="text-tone-info text-[12.5px]">{applying}</span> : null;
  const queueNote = evictionDisabled(v, 'allkeys-lru');
  return (
    <>
      <Kv k="When full" tech={`${evict.tech} · swarmy.cache.evictionPolicy`}>
        <span className="text-[13px]">It {evict.say}.</span>
        {note}
        <Depth at="controls">
          <Picker<CacheEvictionPolicy>
            label="When full"
            choices={EVICTION_CHOICES}
            value={policy.eviction}
            busy={set.isPending}
            disabled={(c) => evictionDisabled(v, c)}
            onPick={(evictionPolicy) => set.mutate({ ...ref, evictionPolicy })}
          />
          {queueNote ? <span className="text-muted-foreground text-xs">{queueNote}</span> : null}
        </Depth>
      </Kv>
      <Kv k="Persistence" tech={`${keep.tech} · swarmy.cache.persistence`}>
        <span className="text-[13px]">
          {policy.persistence === 'off' ? 'Off' : 'On'}: {keep.say}.
        </span>
        {note}
        <Depth at="controls">
          <Picker<CachePersistence>
            label="Persistence"
            choices={PERSISTENCE_CHOICES}
            value={policy.persistence}
            busy={set.isPending}
            onPick={(persistence) => set.mutate({ ...ref, persistence })}
          />
        </Depth>
      </Kv>
    </>
  );
}
