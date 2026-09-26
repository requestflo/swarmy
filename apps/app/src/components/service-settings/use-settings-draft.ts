import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { applySentence, draftChanges, toCalls, type Change, type SettingsDraft } from './settings-model';

export interface SettingsDraftState {
  draft: SettingsDraft;
  set: (patch: SettingsDraft) => void;
  reset: () => void;
  changes: Change[];
  sentence: string;
  apply: () => void;
  applying: boolean;
}

/**
 * The local draft over the live spec, and Apply: `services.update` with only
 * the changed knobs, then `services.scale` when the copy count changed.
 */
export function useSettingsDraft(serviceId: string, spec: ServiceSpec | null | undefined, copies: number): SettingsDraftState {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<SettingsDraft>({});
  React.useEffect(() => setDraft({}), [serviceId]);
  const update = useMutation(trpc.services.update.mutationOptions());
  const scale = useMutation(trpc.services.scale.mutationOptions());
  const live = spec ?? null;
  const changes = draftChanges(live, copies, draft);

  const apply = (): void => {
    const calls = toCalls(serviceId, live, copies, draft);
    void (async () => {
      try {
        if (calls.update) await update.mutateAsync(calls.update);
        if (calls.copies !== null) await scale.mutateAsync({ id: serviceId, replicas: calls.copies });
        toast.success(`Rolling out ${changes.length === 1 ? 'the change' : `${changes.length} changes`}.`);
        setDraft({});
        await qc.invalidateQueries();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'That change did not go through.');
      }
    })();
  };

  return {
    draft,
    set: (patch) => setDraft((d) => ({ ...d, ...patch })),
    reset: () => setDraft({}),
    changes,
    sentence: applySentence(live, copies, changes),
    apply,
    applying: update.isPending || scale.isPending,
  };
}
