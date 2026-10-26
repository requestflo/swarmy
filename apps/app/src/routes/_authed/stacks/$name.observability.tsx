import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackObservabilityTab } from '@/components/observability/stack-observability-tab';
import { LOG_RANGE_PRESETS, type LogRangePreset } from '@/components/observability/logs-shared';

/** `?q=` opens the log stream searching for it (a replay's request id); `?range=` sets the window. */
interface ObservabilitySearch {
  q?: string;
  range?: LogRangePreset;
}

/** Observability tab: logs, metrics, traces, health & status page for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/observability')({
  validateSearch: (search: Record<string, unknown>): ObservabilitySearch => {
    const q = typeof search.q === 'string' && search.q.trim() ? search.q.trim().slice(0, 512) : undefined;
    const range = LOG_RANGE_PRESETS.find((p) => p.value === search.range)?.value;
    return { ...(q ? { q } : {}), ...(range ? { range } : {}) };
  },
  component: ObservabilityTab,
});

function ObservabilityTab(): React.JSX.Element {
  const { name } = Route.useParams();
  const { q, range } = Route.useSearch();
  return <StackObservabilityTab key={`${q ?? ''}|${range ?? ''}`} stack={name} search={q} range={range} />;
}
