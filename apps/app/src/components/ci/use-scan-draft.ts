import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { buildOptions, toggleId } from './git-scan-model';
import type { AppScan, BuildOptions, Draft } from './git-scan-types';
import { useDebouncedValue } from './use-debounced-value';

export interface BuildForm {
  path: string;
  dockerfile: string;
  target: string;
  args: string;
  watch: string;
}

const EMPTY: BuildForm = { path: '', dockerfile: '', target: '', args: '', watch: '' };

/**
 * The board's state: which detections are ticked (all, to start) and the
 * Build · advanced fields; the swarmy.yaml itself always comes from
 * `gitConnections.draftConfig` — generated and re-parsed on the controller —
 * so "valid · v1" is the parser's word. Typing is debounced; ticks are not.
 */
export function useScanDraft(found: AppScan) {
  const trpc = useTRPC();
  const [selected, setSelected] = React.useState<string[]>(() => found.detections.map((d) => d.id));
  const [form, setForm] = React.useState<BuildForm>(EMPTY);
  const buildKey = useDebouncedValue(JSON.stringify(buildOptions(form)), 400);
  const build = React.useMemo(() => JSON.parse(buildKey) as BuildOptions, [buildKey]);
  const draft = useQuery({
    ...trpc.gitConnections.draftConfig.queryOptions({ app: found.app, dir: found.dir, detections: found.detections, selected, build }),
    placeholderData: keepPreviousData,
  });
  return {
    selected,
    toggle: (id: string) => setSelected((s) => toggleId(s, id)),
    form,
    setField: (k: keyof BuildForm, v: string) => setForm((f) => ({ ...f, [k]: v })),
    draft: draft.data as Draft | undefined,
    isPending: draft.isPending,
    /** A newer draft is on its way (the shown one is the previous). */
    isFetching: draft.isFetching,
    isError: draft.isError,
    error: draft.error,
    refetch: () => void draft.refetch(),
  };
}

export type ScanDraft = ReturnType<typeof useScanDraft>;
