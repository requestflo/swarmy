import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Depth, SayHeader, Section } from '@/components/calm';
import { PageSkeleton, ErrorState } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { DbDeclareClusterForm } from '@/components/stacks/db-declare-cluster-form';
import { CacheSection } from '@/components/cache/cache-section';
import { SearchSection } from '@/components/searchsvc/search-section';
import { VectorSection } from '@/components/vector/vector-section';
import { StudioEntryCard } from '@/components/studio/studio-entry-card';
import { DataCode } from './data-code';
import { dataHeadline } from './data-headline';
import { PgHaSection } from './pg-ha-section';
import { PgIfStopped } from './pg-if-stopped';
import { PgNextAction } from './pg-next-action';
import { currentChoice, recommendedChoice, type HaChoice } from './pg-choices';
import { useDataTab } from './use-data-tab';

/**
 * The app's Data tab (RDatabase + DataStores boards): one sentence for all of
 * its data, each Postgres database with its three honest "if a server fails"
 * choices, then caches / search / vector stores in plain words. The aside
 * carries the code view, what would happen right now, and the one action.
 */
export function DataTabPage({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const d = useDataTab(stack);
  const [picked, setPicked] = React.useState<{ cluster: string; choice: HaChoice } | null>(null);

  const focusCluster = d.clusters.find((c) => c.name === picked?.cluster) ?? d.clusters[0];
  const focusName = focusCluster?.name ?? '';
  const readiness = useQuery({
    ...trpc.db.failoverReadiness.queryOptions({ stack, cluster: focusName }),
    enabled: !!focusName,
  });
  const autoBlocked = readiness.data && !readiness.data.ok ? readiness.data.reason : null;

  if (d.pending) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;
  if (d.error) return <ErrorState title="Couldn’t load this app’s data" error={d.error} />;

  const today = focusCluster ? currentChoice(focusCluster) : null;
  const chosen = picked && focusCluster && picked.cluster === focusName ? picked.choice : (recommendedChoice(today, !autoBlocked) ?? today);
  const head = dataHeadline(stack, d);
  const focusBackup = focusCluster ? (d.backups[focusCluster.name] ?? null) : null;

  return (
    <div className="flex flex-col gap-5">
      <SayHeader size="md" title={head.title} lede={head.lede} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          {d.clusters.map((c) => (
            <PgHaSection
              key={c.name}
              stack={stack}
              cluster={c}
              backup={d.backups[c.name] ?? null}
              selected={picked?.cluster === c.name ? picked.choice : null}
              onSelect={(choice) => setPicked({ cluster: c.name, choice })}
              autoBlocked={c.name === focusName ? autoBlocked : null}
            />
          ))}
          <div id="cache" className="scroll-mt-4">
            <CacheSection stack={stack} />
          </div>
          <div id="search" className="scroll-mt-4">
            <SearchSection stack={stack} />
          </div>
          <div id="vector" className="scroll-mt-4">
            <VectorSection stack={stack} />
          </div>
          {d.clusters.length === 0 ? (
            <Section title="Add a database">
              <DbDeclareClusterForm stack={stack} existingNames={[]} />
            </Section>
          ) : (
            <Depth at="controls">
              <Section title="Add another database" hint="each one is independent, on its own private network">
                <DbDeclareClusterForm stack={stack} existingNames={d.clusters.map((c) => c.name)} />
              </Section>
              <StudioEntryCard stack={stack} />
            </Depth>
          )}
        </div>
        <aside aria-label="About this data" className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-4">
          <DataCode
            stack={stack}
            clusters={d.clusters}
            backups={d.backups}
            focus={focusCluster && chosen ? { cluster: focusCluster.name, choice: chosen } : null}
            caches={d.caches}
            search={d.search}
            vectors={d.vectors}
          />
          {focusCluster && chosen ? <PgIfStopped cluster={focusCluster} backup={focusBackup} choice={chosen} /> : null}
          {focusCluster && chosen && chosen !== today && !(chosen === 'auto' && autoBlocked) ? (
            <PgNextAction stack={stack} cluster={focusCluster} choice={chosen} />
          ) : null}
        </aside>
      </div>
    </div>
  );
}
