import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { ErrorState } from '@/components/states';
import { BlueprintFilterBar } from './blueprint-filter-bar';
import { categoryCounts, filterBlueprints, matchesQuery, type CategoryFilter } from './blueprint-filter';
import { TemplateCard } from './template-card';
import { TemplateConfigure } from './template-configure';
import { TemplateCode } from './template-code';

/**
 * Deploy → Templates (canvas "Templates" + "Configure"): a searchable grid,
 * each card a one-line "what you get". Picking one (or arriving with
 * `?app=<id>` from the Deploy hub) fills the Configure panel beside it.
 */
export function BlueprintsPage({ app }: { app?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const blueprints = useQuery(trpc.blueprints.list.queryOptions());
  const cards = React.useMemo(() => blueprints.data ?? [], [blueprints.data]);
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState<CategoryFilter>('all');
  const categories = React.useMemo(() => categoryCounts(cards, query), [cards, query]);
  const matching = React.useMemo(() => cards.filter((m) => matchesQuery(m, query)).length, [cards, query]);
  const visible = React.useMemo(() => filterBlueprints(cards, query, category), [cards, query, category]);
  const selected = cards.find((m) => m.id === app) ?? null;
  const deployable = cards.filter((m) => !m.docOnly).length;

  const pick = (id: string | undefined): void => {
    void navigate({ to: '/blueprints', search: id ? { app: id } : {}, replace: true, resetScroll: false });
    if (id && window.matchMedia('(max-width: 1279px)').matches) {
      requestAnimationFrame(() => document.getElementById('template-configure')?.scrollIntoView({ behavior: 'smooth' }));
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">
      <SectionHeader
        title={blueprints.isPending ? 'Templates' : `${deployable} apps, ready to run.`}
        description="Each one arrives with its database, passwords and web address wired in. Pick one, name it, deploy."
        actions={
          <Button asChild variant="outline" className="pointer-coarse:min-h-11">
            <Link to="/deploy">Compose, image or git instead</Link>
          </Button>
        }
      />
      {blueprints.isError ? (
        <ErrorState title="Couldn't load the templates." error={blueprints.error} retry={() => void blueprints.refetch()} />
      ) : (
        <div className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex min-w-0 flex-col">
            {blueprints.isPending ? null : (
              <BlueprintFilterBar
                query={query}
                onQueryChange={setQuery}
                category={category}
                onCategoryChange={setCategory}
                categories={categories}
                total={matching}
              />
            )}
            {blueprints.isPending ? (
              <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="shimmer-line h-28 rounded-2xl" />
                ))}
              </div>
            ) : visible.length === 0 ? (
              <p className="text-muted-foreground calm-card px-5 py-6 text-sm">
                No apps match.{' '}
                <button type="button" className="text-primary font-semibold hover:underline" onClick={() => { setQuery(''); setCategory('all'); }}>
                  Show them all
                </button>
                , or bring your own from the <Link to="/deploy" className="text-primary font-semibold hover:underline">Deploy page</Link>.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {visible.map((meta) => (
                  <TemplateCard key={meta.id} meta={meta} selected={meta.id === selected?.id} onPick={pick} />
                ))}
              </div>
            )}
          </div>
          <aside id="template-configure" className={selected ? 'order-first flex min-w-0 flex-col gap-4 xl:order-none' : 'hidden min-w-0 flex-col gap-4 xl:flex'}>
            {selected ? (
              <div className="flex flex-col gap-4 xl:sticky xl:top-4">
                <TemplateCode meta={selected} />
                <TemplateConfigure meta={selected} onClose={() => pick(undefined)} />
              </div>
            ) : (
              <p className="calm-card text-muted-foreground px-5 py-6 text-[13.5px]">
                Pick an app to see what you get. Nothing runs until you press Deploy.
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
