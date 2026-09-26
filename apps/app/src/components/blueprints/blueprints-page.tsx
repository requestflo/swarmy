import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CalmPage, SayHeader } from '@/components/calm';
import { ErrorState } from '@/components/states';
import { BlueprintFilterBar } from './blueprint-filter-bar';
import { categoryCounts, filterBlueprints, matchesQuery, matchesToggles, type CategoryFilter, type TemplateToggles } from './blueprint-filter';
import { TemplateAside } from './template-aside';
import { TemplateGrid } from './template-grid';

/**
 * Deploy → Templates (board 53): every bundled app in a dense grid with
 * search, categories and three quick toggles. The first card is picked so the
 * aside always says what an app creates and where it fits; its coral button
 * goes on to Configure (`/deploy/<id>`). One count, from one list: the
 * deployable templates (doc-only cards aren't apps).
 */
export function BlueprintsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const list = useQuery(trpc.blueprints.list.queryOptions());
  // Catalogue apps first; the bring-your-own-image starters close the grid.
  const cards = React.useMemo(
    () => (list.data ?? []).filter((m) => !m.docOnly).sort((a, b) => Number(a.category === 'app') - Number(b.category === 'app')),
    [list.data],
  );
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState<CategoryFilter>('all');
  const [toggles, setToggles] = React.useState<TemplateToggles>({});
  const [picked, setPicked] = React.useState<string | null>(null);
  const categories = React.useMemo(() => categoryCounts(cards, query, toggles), [cards, query, toggles]);
  const matching = cards.filter((m) => matchesQuery(m, query) && matchesToggles(m, toggles)).length;
  const visible = React.useMemo(() => filterBlueprints(cards, query, category, toggles), [cards, query, category, toggles]);
  const selected = cards.find((m) => m.id === picked) ?? visible[0] ?? cards[0] ?? null;
  const total = cards.length;

  const pick = (id: string): void => {
    setPicked(id);
    if (window.matchMedia('(max-width: 1279px)').matches) {
      requestAnimationFrame(() => document.getElementById('template-aside')?.scrollIntoView({ behavior: 'smooth' }));
    }
  };
  const reset = (): void => {
    setQuery('');
    setCategory('all');
    setToggles({});
  };

  return (
    <CalmPage
      wide
      crumbs={[{ label: 'Deploy', to: '/deploy' }, { label: 'templates' }]}
      aside={
        selected ? (
          <div id="template-aside" className="scroll-mt-4 xl:sticky xl:top-4">
            <TemplateAside meta={selected} />
          </div>
        ) : list.isPending ? (
          <div className="shimmer-line h-96 rounded-2xl" />
        ) : null
      }
    >
      <SayHeader
        eyebrow={list.isPending ? 'Templates' : `Templates · ${total} apps`}
        title={
          <>
            Bundled with swarmy, every version pinned. <em>Reviewed before it ships.</em>
          </>
        }
        actions={
          <Button asChild variant="outline" className="pointer-coarse:min-h-11">
            <Link to="/deploy">Compose, image or git instead</Link>
          </Button>
        }
      />
      {list.isError ? (
        <ErrorState title="Couldn't load the templates." error={list.error} retry={() => void list.refetch()} />
      ) : list.isPending ? (
        <TemplateGrid.Skeleton />
      ) : (
        <>
          <BlueprintFilterBar
            query={query}
            onQueryChange={setQuery}
            category={category}
            onCategoryChange={setCategory}
            categories={categories}
            toggles={toggles}
            onTogglesChange={setToggles}
            matching={matching}
            showing={visible.length}
            total={total}
          />
          {visible.length === 0 ? (
            <p className="text-muted-foreground calm-card px-5 py-6 text-sm">
              No apps match.{' '}
              <button type="button" className="text-primary font-semibold hover:underline" onClick={reset}>
                Show them all
              </button>
              , or bring your own from the{' '}
              <Link to="/deploy" className="text-primary font-semibold hover:underline">
                Deploy page
              </Link>
              .
            </p>
          ) : (
            <TemplateGrid cards={visible} selected={selected?.id ?? null} onPick={pick} />
          )}
        </>
      )}
    </CalmPage>
  );
}
