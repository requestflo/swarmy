import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import { Button, Collapsible, CollapsibleContent } from '@swarmy/ui';
import { Depth, RowList, Section, useDepth } from '@/components/calm';
import { CardSkeleton } from '@/components/states';

/**
 * The shared shell for the Data tab's caches / search / vector sections:
 * Summary shows one plain `CalmRow` per instance (and nothing when there are
 * none — the tab lists only what the app uses); Controls adds the existing
 * expandable rows, the inline "New …" form and the empty state.
 */
export function ManagedServiceSection({
  title,
  count,
  newLabel,
  renderForm,
  banner,
  loading,
  error,
  onRetry,
  summaryRows,
  controlRows,
  empty,
  footer,
}: {
  title: string;
  count: number;
  newLabel: string;
  renderForm: (done: () => void) => React.ReactNode;
  banner?: React.ReactNode;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  summaryRows: React.ReactNode;
  controlRows: React.ReactNode;
  /** One sentence for Controls when there are none yet. */
  empty: string;
  footer?: React.ReactNode;
}): React.JSX.Element | null {
  const { atLeast } = useDepth();
  const [creating, setCreating] = React.useState(false);
  const controls = atLeast('controls');
  if (!controls && !loading && !error && count === 0 && !banner) return null;

  return (
    <Section
      title={title}
      count={count > 0 ? count : undefined}
      flush={!controls}
      action={
        controls ? (
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
            <PlusIcon className="size-4" /> {newLabel}
          </Button>
        ) : null
      }
    >
      <Depth at="controls">
        <Collapsible open={creating} onOpenChange={setCreating}>
          <CollapsibleContent>
            <div className="border-border mb-2 rounded-xl border p-4">{renderForm(() => setCreating(false))}</div>
          </CollapsibleContent>
        </Collapsible>
      </Depth>
      {banner}
      {loading ? (
        <CardSkeleton lines={2} className="border-0 p-0 shadow-none" />
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3 py-2">
          <p className="text-tone-bad text-sm">{error}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : count === 0 ? (
        <p className="text-muted-foreground py-1 text-[13.5px]">{empty}</p>
      ) : controls ? (
        <div className="divide-border divide-y">{controlRows}</div>
      ) : (
        <RowList label={title}>{summaryRows}</RowList>
      )}
      {footer ? <Depth at="controls">{footer}</Depth> : null}
    </Section>
  );
}
