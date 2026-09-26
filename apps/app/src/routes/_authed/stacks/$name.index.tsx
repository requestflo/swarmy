import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AppOverviewTab } from '@/components/stacks/workspace/app-overview-tab';

interface StackOverviewSearch {
  /** Selected part: its settings panel opens over the canvas (phones: a full-height sheet). */
  part?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The app's Overview tab: how it is built (the live canvas), facts and the next thing worth doing. */
export const Route = createFileRoute('/_authed/stacks/$name/')({
  validateSearch: (search: Record<string, unknown>): StackOverviewSearch => {
    // `service` was the retired overlay's param — it now opens the same panel.
    const part = str(search.part) ?? str(search.service);
    return part ? { part } : {};
  },
  component: StackOverviewTab,
});

function StackOverviewTab(): React.JSX.Element {
  const { name } = Route.useParams();
  const { part } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AppOverviewTab
      stack={name}
      part={part}
      onSelect={(id) => void navigate({ search: id ? { part: id } : {}, replace: !!part, resetScroll: false })}
    />
  );
}
