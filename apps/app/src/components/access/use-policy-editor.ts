import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parsePolicyDoc } from '@swarmy/abac/model';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { draftToDoc, docToDraft, EMPTY_DRAFT, previewSource, type RuleDraft } from './policy-draft';

export interface PolicyRow {
  id: string;
  name: string;
  description: string | null;
  effect: 'permit' | 'forbid';
  source: string;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  sentence: string;
}

/** Editor state: the picker draft, or raw JSON for rules the pickers can't express. */
export function usePolicyEditor(initial: PolicyRow | null, onSaved: () => void) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const seed = React.useMemo(() => {
    if (!initial) return { draft: EMPTY_DRAFT, json: false };
    try {
      const d = docToDraft(initial.name, initial.effect, parsePolicyDoc(initial.source));
      return d ? { draft: d, json: false } : { draft: { ...EMPTY_DRAFT, name: initial.name, effect: initial.effect }, json: true };
    } catch {
      return { draft: { ...EMPTY_DRAFT, name: initial.name, effect: initial.effect }, json: true };
    }
  }, [initial]);

  const [draft, setDraft] = React.useState<RuleDraft>(seed.draft);
  const [jsonMode, setJsonMode] = React.useState(seed.json);
  const [source, setSource] = React.useState(initial?.source ?? JSON.stringify(draftToDoc(seed.draft), null, 2));
  const [priority, setPriority] = React.useState(initial?.priority ?? 60);

  const patch = (p: Partial<RuleDraft>): void => setDraft((d) => ({ ...d, ...p }));
  const effectiveSource = jsonMode ? source : JSON.stringify(draftToDoc(draft), null, 2);
  const preview = previewSource(effectiveSource, draft.effect);

  const toJson = (): void => {
    setSource(JSON.stringify(draftToDoc(draft), null, 2));
    setJsonMode(true);
  };

  const save = useMutation(
    trpc.policies.set.mutationOptions({
      onSuccess: () => {
        toast.success('Rule saved');
        void qc.invalidateQueries();
        onSaved();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void =>
    save.mutate({
      ...(initial ? { id: initial.id } : {}),
      name: draft.name.trim() || ('sentence' in preview ? preview.sentence.slice(0, 120) : 'Rule'),
      effect: draft.effect,
      source: effectiveSource,
      priority,
    });

  return { draft, patch, jsonMode, toJson, source, setSource, priority, setPriority, preview, submit, saving: save.isPending };
}
