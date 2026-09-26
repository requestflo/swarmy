import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BlueprintParamsInput, type BlueprintMetaView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { useOnlineNodeCount } from '@/lib/use-online-node-count';
import { defaultSizeForNodes } from './blueprint-option-fields';
import { defaultAppName } from './template-words';

/** Hold a value until it has stopped changing for `ms` (typing into the name). */
export function useSettled<T>(value: T, ms = 350): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * The template's dry-run plan (`blueprints.plan`) for these params — nothing
 * runs. Defaults to the template's own name and the size the fleet suits.
 * Skipped while the params don't validate (a half-typed name).
 */
export function useTemplatePlan(meta: BlueprintMetaView | null, params?: Partial<BlueprintParamsInput>) {
  const trpc = useTRPC();
  const online = useOnlineNodeCount();
  const full = meta
    ? BlueprintParamsInput.safeParse({
        name: defaultAppName(meta),
        size: defaultSizeForNodes(online),
        options: {},
        ...params,
      })
    : null;
  const key = meta && full?.success ? JSON.stringify({ id: meta.id, params: full.data }) : null;
  const settledKey = useSettled(key);
  const settled = React.useMemo(() => (settledKey ? (JSON.parse(settledKey) as { id: string; params: BlueprintParamsInput }) : null), [settledKey]);
  return useQuery({
    ...trpc.blueprints.plan.queryOptions(settled ?? { id: 'x', params: { name: 'x', size: 'm', options: {} } }),
    enabled: settled !== null && !(meta?.docOnly ?? false),
    placeholderData: (prev) => (prev && prev.id === settled?.id ? prev : undefined),
    retry: false,
  });
}
