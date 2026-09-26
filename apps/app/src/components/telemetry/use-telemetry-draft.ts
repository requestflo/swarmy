import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { sameTelemetrySettings, type TelemetrySettings } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

export interface TelemetryDraft {
  /** What the page shows: the local draft, else the saved settings. */
  current: TelemetrySettings | undefined;
  /** The draft differs from what is saved. */
  dirty: boolean;
  change: (fn: (s: TelemetrySettings) => TelemetrySettings) => void;
  discard: () => void;
  apply: () => void;
  applying: boolean;
  error: string | null;
}

/**
 * The page edits a local draft; "Apply to the collector" saves it with
 * `observability.setSettings`, which re-renders and applies it in one go.
 */
export function useTelemetryDraft(saved: TelemetrySettings | undefined): TelemetryDraft {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<TelemetrySettings | null>(null);
  const current = draft ?? saved;
  const save = useMutation(
    trpc.observability.setSettings.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.observability.settings.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.observability.pipeline.queryKey() });
        setDraft(null);
      },
    }),
  );
  return {
    current,
    dirty: !!draft && !!saved && !sameTelemetrySettings(draft, saved),
    change: (fn) => {
      if (current) setDraft(fn(structuredClone(current)));
    },
    discard: () => setDraft(null),
    apply: () => {
      if (draft) save.mutate(draft);
    },
    applying: save.isPending,
    error: save.error ? save.error.message : null,
  };
}
