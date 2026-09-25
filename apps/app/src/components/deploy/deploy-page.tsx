import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { BlueprintCategory } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { TemplateCard } from '@/components/blueprints/template-card';
import { GitNewAppCard } from '@/components/ci/git-new-app-card';
import type { DeployChoice } from './deploy-choice';
import { OwnChoices } from './own-choices';
import { DeploySelection } from './deploy-selection';
import { DeployCode } from './deploy-code';
import { DeployFit } from './deploy-fit';

/** The plain-words shelves (RDeploy), each a template category. */
const SHELVES: { id: BlueprintCategory; label: string }[] = [
  { id: 'cms', label: 'A website or blog' },
  { id: 'analytics', label: 'Visitor stats' },
  { id: 'automation', label: 'Automation' },
  { id: 'productivity', label: 'Team tools' },
  { id: 'ai', label: 'AI' },
];

/**
 * Deploy an app (RDeploy): "What are you putting online?" — a few templates
 * per shelf, a link to all of them, and bring-your-own (git, compose, image).
 * The aside says what the pick gives you and holds the one coral step on;
 * Controls adds what swarmy generates; Code shows the file and the call.
 */
export function DeployPage(): React.JSX.Element {
  const trpc = useTRPC();
  const list = useQuery(trpc.blueprints.list.queryOptions());
  const all = React.useMemo(() => (list.data ?? []).filter((m) => !m.docOnly), [list.data]);
  const [shelf, setShelf] = React.useState<BlueprintCategory | 'own'>('cms');
  const [choice, setChoice] = React.useState<DeployChoice | null>(null);
  const featured = shelf === 'own' ? [] : all.filter((m) => m.category === shelf).slice(0, 4);
  const current: DeployChoice | null = choice ?? (featured[0] ? { kind: 'template', id: featured[0].id } : null);
  const template = current?.kind === 'template' ? (all.find((m) => m.id === current.id) ?? null) : null;

  const chip = (id: BlueprintCategory | 'own', label: string): React.JSX.Element => (
    <button
      key={id}
      type="button"
      aria-pressed={shelf === id}
      onClick={() => {
        setShelf(id);
        setChoice(id === 'own' ? { kind: 'git' } : null);
      }}
      className={cn(
        'min-h-10 rounded-full border px-4 text-[13.5px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        shelf === id ? 'bg-foreground text-background border-transparent' : 'border-border hover:bg-foreground/[0.04]',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">
      <SectionHeader eyebrow="Nothing runs until you press Deploy" title="What are you putting online?" />
      <div className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div role="group" aria-label="Kinds of app" className="flex flex-wrap gap-2">
            {SHELVES.filter((s) => list.isPending || all.some((m) => m.category === s.id)).map((s) => chip(s.id, s.label))}
            {chip('own', 'My own code')}
          </div>
          {shelf !== 'own' ? (
            list.isPending ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {[0, 1, 2, 3].map((i) => <div key={i} className="shimmer-line h-28 rounded-2xl" />)}
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {featured.map((m) => (
                    <TemplateCard key={m.id} meta={m} selected={template?.id === m.id} onPick={(id) => setChoice({ kind: 'template', id })} />
                  ))}
                </div>
                <Link to="/blueprints" className="text-primary w-fit font-mono text-[12.5px] hover:underline">
                  Browse all {all.length} apps →
                </Link>
              </>
            )
          ) : null}
          <OwnChoices value={current && current.kind !== 'template' ? current.kind : null} onPick={(k) => setChoice({ kind: k })} />
          {current?.kind === 'git' ? <GitNewAppCard onClose={() => setChoice(null)} /> : null}
          {template ? <DeployFit template={template} /> : null}
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          {current ? <DeployCode choice={current} template={template} /> : null}
          {current ? <DeploySelection choice={current} template={template} /> : null}
        </aside>
      </div>
    </div>
  );
}
