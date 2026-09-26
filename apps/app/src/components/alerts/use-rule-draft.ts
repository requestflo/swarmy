import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ALERT_SIGNAL_INFO, selectorKey, type AlertRuleView, type AlertSelector, type AlertSignal } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { clockTime } from './rule-sentence';

export interface RuleDraft {
  name: string;
  signal: AlertSignal;
  /** What the rule watches: `{}` = any app/server (Q10). */
  selector: AlertSelector;
  threshold: number | null;
  forSeconds: number;
  channelIds: string[];
  enabled: boolean;
}

/** "Mute for 1h" (the controller's default; audited). */
export const MUTE_MINUTES = 60;

/** A fresh rule for a signal, from the catalog defaults. */
export function draftForSignal(signal: AlertSignal, channelIds: string[] = []): RuleDraft {
  const info = ALERT_SIGNAL_INFO[signal];
  return { name: info.label, signal, selector: {}, threshold: info.defaultThreshold, forSeconds: info.defaultForSeconds, channelIds, enabled: true };
}

const fromRule = (r: AlertRuleView): RuleDraft => ({
  name: r.name,
  signal: r.signal as AlertSignal,
  selector: r.selector,
  threshold: r.threshold,
  forSeconds: r.forSeconds,
  channelIds: r.channelIds,
  enabled: r.enabled,
});

const same = (a: RuleDraft, b: RuleDraft): boolean =>
  JSON.stringify({ ...a, selector: selectorKey(a.selector), channelIds: [...a.channelIds].sort() }) ===
  JSON.stringify({ ...b, selector: selectorKey(b.selector), channelIds: [...b.channelIds].sort() });

/** The editor's working copy: dirty when it differs from what's saved (a new rule is always unsaved). */
export function useRuleDraft(rule: AlertRuleView | null, onSaved: (id: string) => void, onDeleted: () => void) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const base = React.useMemo(() => (rule ? fromRule(rule) : draftForSignal('error-rate')), [rule]);
  const [draft, setDraft] = React.useState<RuleDraft>(base);
  const dirty = !rule || !same(draft, base);
  const patch = (p: Partial<RuleDraft>): void => setDraft((d) => ({ ...d, ...p }));
  const refresh = (): void => void qc.invalidateQueries({ queryKey: trpc.alerts.pathKey() });

  const done = (r: AlertRuleView, verb: string): void => {
    toast.success(`${r.name} ${verb}. It applies on the next check.`);
    refresh();
    onSaved(r.id);
  };
  const create = useMutation(trpc.alerts.createRule.mutationOptions({ onSuccess: (r) => done(r, 'saved'), onError: (e) => toast.error(e.message) }));
  const update = useMutation(trpc.alerts.updateRule.mutationOptions({ onSuccess: (r) => done(r, 'updated'), onError: (e) => toast.error(e.message) }));
  const mute = useMutation(
    trpc.alerts.muteRule.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.name} is muted until ${r.mutedUntil ? clockTime(r.mutedUntil) : 'later'}. It still records what happens.`);
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const unmute = useMutation(
    trpc.alerts.unmuteRule.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.name} is back on. Anything still firing goes out now.`);
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.alerts.deleteRule.mutationOptions({
      onSuccess: () => {
        toast.success(rule?.isDefault ? `${rule.name} removed. swarmy won’t add it back.` : `${rule?.name ?? 'Rule'} removed.`);
        refresh();
        onDeleted();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const save = (): void => {
    const body = { ...draft, name: draft.name.trim() || ALERT_SIGNAL_INFO[draft.signal].label };
    if (!rule) create.mutate(body);
    else
      update.mutate({
        id: rule.id,
        name: body.name,
        selector: body.selector,
        threshold: body.threshold,
        forSeconds: body.forSeconds,
        channelIds: body.channelIds,
        enabled: body.enabled,
      });
  };

  return {
    draft,
    base,
    dirty,
    patch,
    reset: () => setDraft(base),
    save,
    saving: create.isPending || update.isPending,
    mute: () => rule && mute.mutate({ id: rule.id, minutes: MUTE_MINUTES }),
    unmute: () => rule && unmute.mutate({ id: rule.id }),
    muting: mute.isPending || unmute.isPending,
    remove: () => rule && remove.mutate({ id: rule.id }),
    removing: remove.isPending,
  };
}
