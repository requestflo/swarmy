import * as React from 'react';
import { Button } from '@swarmy/ui';
import type { TelemetrySettingsView } from '@swarmy/core';
import { Tech } from '@/components/calm';
import { relTime } from '@/lib/format';
import type { TelemetryDraft } from './use-telemetry-draft';

/**
 * The page's ONE coral action — shown only while the draft differs from what
 * is saved. Otherwise a quiet line says whether the collector has it.
 */
export function TelemetryApply({
  draft,
  view,
  quiet,
}: {
  draft: TelemetryDraft;
  view: TelemetrySettingsView | undefined;
  /** Another coral owns the page (e.g. "Turn on telemetry"): draw Apply quietly. */
  quiet?: boolean;
}): React.JSX.Element | null {
  if (!view) return null;
  if (draft.dirty) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button variant={quiet ? 'outline' : 'default'} onClick={draft.apply} disabled={draft.applying} className="pointer-coarse:min-h-11">
            {draft.applying ? 'Applying…' : 'Apply to the collector'}
          </Button>
          <Button variant="ghost" onClick={draft.discard} disabled={draft.applying} className="pointer-coarse:min-h-11">
            Discard
          </Button>
          <span className="text-muted-foreground font-mono text-[11.5px]">
            {view.suiteEnabled ? 'Swaps the collector’s config in seconds · no app restarts' : 'Saved now · used when telemetry is turned on'}
          </span>
        </div>
        <Tech>renders a new collector config (Docker config) and updates only swarmy-otel-collector; each table’s TTL is set right after</Tech>
        {draft.error ? <p className="text-tone-bad text-xs">{draft.error}</p> : null}
      </div>
    );
  }
  if (!view.suiteEnabled) return <p className="text-muted-foreground text-[13px]">Telemetry is off, so nothing is running these settings yet.</p>;
  if (!view.applied) return <p className="text-tone-info text-[13px]">Applying — the collector picks this up in a few seconds.</p>;
  return (
    <p className="text-muted-foreground text-[13px]">
      Applied {view.appliedAt ? relTime(view.appliedAt) : ''} · the collector is running these settings.
    </p>
  );
}
