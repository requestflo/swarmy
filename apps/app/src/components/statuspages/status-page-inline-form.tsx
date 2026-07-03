import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusPageComponent, StatusPageView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StatusPageFields } from './status-page-fields';
import { EMPTY_DRAFT, draftFromPage, draftReady, type PageDraft } from './page-draft';
import { keyFor } from './component-picker';

interface StatusPageInlineFormProps {
  /** The workspace stack — new pages are created attached to it. */
  stack: string;
  /** Present → edit mode; absent → create mode. */
  page?: StatusPageView;
  onDone: () => void;
  onCancel: () => void;
}

/**
 * Inline create/edit body for a stack's status page — lives inside an
 * expanding card / row-expand, never a modal. On create, every component the
 * stack offers is preselected so the page is one "Create" away.
 */
export function StatusPageInlineForm({
  stack,
  page,
  onDone,
  onCancel,
}: StatusPageInlineFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<PageDraft>(() =>
    page ? draftFromPage(page) : EMPTY_DRAFT,
  );

  // Create mode: preselect this stack's components once the options land.
  const options = useQuery({
    ...trpc.statusPages.componentOptions.queryOptions({ stack }),
    enabled: !page,
  });
  const [seeded, setSeeded] = React.useState(Boolean(page));
  React.useEffect(() => {
    if (seeded || !options.data || options.data.length === 0) return;
    setSeeded(true);
    const taken = new Set<string>();
    const components: StatusPageComponent[] = options.data.slice(0, 50).map((o) => {
      const key = keyFor(o, taken);
      taken.add(key);
      return { key, label: o.label, kind: o.kind, ref: o.ref };
    });
    setDraft((d) => (d.components.length === 0 ? { ...d, components } : d));
  }, [seeded, options.data]);

  const done = (verb: string, slug: string): void => {
    toast.success(`Status page ${verb} — it's live at /s/${slug}`);
    void qc.invalidateQueries();
    onDone();
  };
  const create = useMutation(
    trpc.statusPages.create.mutationOptions({
      onSuccess: (p) => done('created', p.slug),
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.statusPages.update.mutationOptions({
      onSuccess: (p) => done('saved', p.slug),
      onError: (e) => toast.error(e.message),
    }),
  );

  const pending = create.isPending || update.isPending;
  const submit = (): void => {
    const common = {
      title: draft.title.trim(),
      components: draft.components,
      showUptime: draft.showUptime,
      showIncidents: draft.showIncidents,
    };
    if (page) {
      update.mutate({
        id: page.id,
        ...common,
        domain: draft.domain.trim() === '' ? null : draft.domain.trim(),
      });
    } else {
      create.mutate({
        ...common,
        slug: draft.slug,
        stackName: stack,
        ...(draft.domain.trim() === '' ? {} : { domain: draft.domain.trim() }),
      });
    }
  };

  return (
    <div className="grid gap-4">
      <StatusPageFields draft={draft} onChange={setDraft} slugLocked={Boolean(page)} stack={stack} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" variant="outline" onClick={submit} disabled={!draftReady(draft) || pending}>
          {pending ? 'Saving…' : page ? 'Save changes' : 'Create page'}
        </Button>
      </div>
    </div>
  );
}
