import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PublicStatusView, StatusPageComponent, StatusPageView } from '@swarmy/core';
import { Input } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Depth, Section, StatusWord } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { keyFor } from './component-picker';
import { componentSource } from './component-source';
import { PUBLIC_STATUS_LABEL } from './status-tone';
import { usePageUpdate } from './use-page-update';

const TONE = { up: 'ok', degraded: 'warn', down: 'bad', unknown: 'idle' } as const;

function NameField({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => void }): React.JSX.Element {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    const v = draft.trim();
    if (v && v !== value) onSave(v);
    else setDraft(value);
  };
  return (
    <Input
      aria-label={`Name visitors see for ${label}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      className="h-9 w-full max-w-40 pointer-coarse:min-h-11"
    />
  );
}

/** "What customers see": each component on the page, its visitor name, where its status comes from, and its status now. */
export function StatusComponentsSection({ page, snapshot }: { page: StatusPageView; snapshot?: PublicStatusView }): React.JSX.Element {
  const trpc = useTRPC();
  const options = useQuery(trpc.statusPages.componentOptions.queryOptions());
  const update = usePageUpdate();
  const save = (components: StatusPageComponent[]): void => update.mutate({ id: page.id, components });
  const optionFor = (c: Pick<StatusPageComponent, 'kind' | 'ref'>) => options.data?.find((o) => o.kind === c.kind && o.ref === c.ref);
  const unused = (options.data ?? []).filter((o) => !page.components.some((c) => c.kind === o.kind && c.ref === o.ref));

  const row = (key: string, on: boolean, name: React.ReactNode, source: string, status: React.ReactNode, toggle: () => void, label: string) => (
    <li key={key} className="border-border flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b py-2.5 last:border-b-0">
      <QuietSwitch checked={on} disabled={update.isPending} onCheckedChange={toggle} aria-label={on ? `Hide ${label} from visitors` : `Show ${label} to visitors`} />
      <div className="min-w-0 flex-1 basis-40">{name}</div>
      <span className="text-muted-foreground min-w-0 flex-1 basis-40 font-mono text-[11.5px] break-words">{source}</span>
      <span className="w-20 shrink-0 text-right">{status}</span>
    </li>
  );

  return (
    <Section title="What customers see" count={`${page.components.length} on the page`}>
      <ul aria-label="Components on the page">
        {page.components.map((c) => {
          const st = snapshot?.components.find((x) => x.key === c.key)?.status ?? 'unknown';
          return row(
            c.key,
            true,
            <NameField value={c.label} label={c.ref} onSave={(label) => save(page.components.map((x) => (x.key === c.key ? { ...x, label } : x)))} />,
            componentSource(c, optionFor(c)),
            <StatusWord tone={TONE[st]} word={st === 'up' ? 'Healthy' : PUBLIC_STATUS_LABEL[st]} />,
            () => save(page.components.filter((x) => x.key !== c.key)),
            c.label,
          );
        })}
      </ul>
      <Depth at="controls">
        {unused.length > 0 ? (
          <ul aria-label="Could also show" className="border-border border-t border-dashed pt-1">
            {unused.map((o) =>
              row(
                `${o.kind}:${o.ref}`,
                false,
                <span className="text-muted-foreground text-sm">{o.label}</span>,
                componentSource(o, o),
                <span className="text-muted-foreground text-xs">hidden</span>,
                () => save([...page.components, { key: keyFor(o, new Set(page.components.map((c) => c.key))), label: o.label, kind: o.kind, ref: o.ref }]),
                o.label,
              ),
            )}
          </ul>
        ) : null}
      </Depth>
      <p className="text-muted-foreground text-xs">Status comes from each app’s health and alert rules — never typed by hand.</p>
    </Section>
  );
}
