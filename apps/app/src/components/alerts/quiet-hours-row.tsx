import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { quietHoursRange, type AlertQuietHoursView } from '@swarmy/core';
import { Button, Input, toast } from '@swarmy/ui';
import { Depth, Tech, useDepth } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';

type QuietDraft = Omit<AlertQuietHoursView, 'activeNow'>;

const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const zones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
};

/** The Summary sentence: what quiet hours do, in plain words. */
export function quietSentence(q: Pick<AlertQuietHoursView, 'enabled' | 'start' | 'end' | 'criticalPages' | 'activeNow'>): string {
  if (!q.enabled) return 'Off: every alert goes out when it happens.';
  const now = q.activeNow ? 'On now. ' : '';
  return q.criticalPages
    ? `${now}Warnings wait from ${q.start} to ${q.end}; critical alerts still page.`
    : `${now}Nothing goes out from ${q.start} to ${q.end}, not even critical alerts.`;
}

/** Board 45's row: "22:00–07:00 · critical alerts still page". */
export function quietLine(q: Pick<AlertQuietHoursView, 'start' | 'end' | 'criticalPages'>): string {
  return `${quietHoursRange(q)} · ${q.criticalPages ? 'critical alerts still page' : 'critical alerts wait too'}`;
}

/**
 * Quiet hours for the whole workspace, in the channels column (board 45): a
 * switch, then one plain sentence at Summary; the range line plus start, end,
 * time zone and "critical alerts still page" at Controls. During quiet hours
 * warnings are held and sent once when they end, if still firing.
 */
export function QuietHoursRow({ quiet }: { quiet: AlertQuietHoursView | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { atLeast } = useDepth();
  const uid = React.useId();
  const base: QuietDraft | null = quiet
    ? { enabled: quiet.enabled, start: quiet.start, end: quiet.end, timeZone: quiet.timeZone, criticalPages: quiet.criticalPages }
    : null;
  const [draft, setDraft] = React.useState<QuietDraft | null>(base);
  React.useEffect(() => setDraft(base), [quiet?.enabled, quiet?.start, quiet?.end, quiet?.timeZone, quiet?.criticalPages]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation(
    trpc.alerts.setQuietHours.mutationOptions({
      onSuccess: (q) => {
        toast.success(q.enabled ? `Quiet hours on: ${quietHoursRange(q)}.` : 'Quiet hours off. Anything held goes out now.');
        void qc.invalidateQueries({ queryKey: trpc.alerts.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!quiet || !draft) {
    return <div className="calm-card text-muted-foreground px-3.5 py-3 text-sm">Checking quiet hours…</div>;
  }
  const toggle = (enabled: boolean): void => {
    // First switch-on from the untouched default: use the viewer's own zone.
    const timeZone = enabled && quiet.timeZone === 'UTC' && !quiet.enabled ? browserZone() : draft.timeZone;
    save.mutate({ ...draft, enabled, timeZone });
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const patch = (p: Partial<QuietDraft>): void => setDraft((d) => (d ? { ...d, ...p } : d));

  return (
    <section aria-label="Quiet hours" className="calm-card flex flex-col gap-3 px-3.5 py-3">
      <label className="flex items-start gap-3">
        <QuietSwitch checked={quiet.enabled} disabled={save.isPending} onCheckedChange={toggle} aria-label="Quiet hours" className="mt-0.5" />
        <span className="flex min-w-0 flex-col">
          <span className="text-[14px] font-semibold">Quiet hours</span>
          <span className="text-muted-foreground text-[12.5px] leading-snug">
            {atLeast('controls') ? quietLine(quiet) : quietSentence(quiet)}
          </span>
        </span>
      </label>
      <Depth at="controls">
        <div className="flex flex-col gap-2.5 pl-12 pointer-coarse:pl-0">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${uid}-s`} className="text-muted-foreground text-[13px]">
              From
            </label>
            <Input id={`${uid}-s`} type="time" value={draft.start} onChange={(e) => patch({ start: e.target.value })} className="h-8 w-[6.5rem] font-mono pointer-coarse:h-11" />
            <label htmlFor={`${uid}-e`} className="text-muted-foreground text-[13px]">
              to
            </label>
            <Input id={`${uid}-e`} type="time" value={draft.end} onChange={(e) => patch({ end: e.target.value })} className="h-8 w-[6.5rem] font-mono pointer-coarse:h-11" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${uid}-z`} className="text-muted-foreground text-[13px]">
              Time zone
            </label>
            <Input
              id={`${uid}-z`}
              list={`${uid}-zones`}
              value={draft.timeZone}
              onChange={(e) => patch({ timeZone: e.target.value })}
              className="h-8 min-w-0 flex-1 font-mono pointer-coarse:h-11"
            />
            <datalist id={`${uid}-zones`}>
              {zones().map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          <label className="flex items-center gap-3 text-[13px]">
            <QuietSwitch checked={draft.criticalPages} onCheckedChange={(criticalPages) => patch({ criticalPages })} aria-label="Critical alerts still page" />
            Critical alerts still page
          </label>
          {dirty ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={save.isPending} onClick={() => save.mutate(draft)}>
                {save.isPending ? 'Saving…' : 'Save quiet hours'}
              </Button>
              <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => setDraft(base)}>
                Discard
              </Button>
            </div>
          ) : null}
          <Tech>
            {draft.timeZone} · warnings in the window are held, then sent once when it ends if still firing · resolved while quiet = never sent
          </Tech>
        </div>
      </Depth>
    </section>
  );
}
