import * as React from 'react';
import type { CacheClusterView, SearchInstanceView, VectorInstanceView } from '@swarmy/core';
import { CodeView, toYaml, withHeader } from '@/components/calm';
import { choiceLabels, currentChoice, type HaChoice, type PgBackupFacts, type PgClusterFacts } from './pg-choices';

type Yaml = Parameters<typeof toYaml>[0];

const HA: Record<HaChoice, string> = { one: 'single', standby: 'primary-replica', auto: 'failover' };

function pgResource(c: PgClusterFacts, b: PgBackupFacts | null, choice: HaChoice | null): Yaml {
  const ha = choice ? HA[choice] : c.topology;
  const replicas = choice ? Number(choiceLabels(choice, c)['swarmy.db.replicas']) : c.replicas.desired;
  return {
    type: 'postgres',
    ha,
    replicas,
    backups: b?.cron ? { schedule: b.cron, keep: b.retentionDays ?? 7 } : undefined,
  };
}

/**
 * The Data tab as code: the swarmy.yaml `resources:` block for every managed
 * data service (the focused database at the choice you picked), the labels
 * swarmy stamps on the swarm, and the CLI that applies the file.
 */
export function DataCode({
  stack,
  clusters,
  backups,
  focus,
  caches,
  search,
  vectors,
}: {
  stack: string;
  clusters: PgClusterFacts[];
  backups: Record<string, PgBackupFacts>;
  focus: { cluster: string; choice: HaChoice } | null;
  caches: CacheClusterView[];
  search: SearchInstanceView[];
  vectors: VectorInstanceView[];
}): React.JSX.Element {
  const resources: Record<string, Yaml> = {};
  for (const c of clusters) {
    const choice = focus?.cluster === c.name ? focus.choice : currentChoice(c);
    resources[c.name] = pgResource(c, backups[c.name] ?? null, choice);
  }
  for (const c of caches) {
    resources[c.name in resources ? `${c.name}-cache` : c.name] = {
      type: 'cache',
      engine: c.engine,
      ha: c.topology,
      replicas: c.declaredReplicas,
      memory: `${c.memoryMb}mb`,
    };
  }
  for (const s of search) resources[s.name in resources ? `${s.name}-search` : s.name] = { type: 'search', engine: s.engine };
  for (const v of vectors) resources[v.name in resources ? `${v.name}-vector` : v.name] = { type: 'vector', engine: 'qdrant' };

  const labels = clusters
    .map((c) => {
      const choice = focus?.cluster === c.name ? focus.choice : currentChoice(c);
      const l = choice ? choiceLabels(choice, c) : { 'swarmy.db.topology': c.topology, 'swarmy.db.replicas': String(c.replicas.desired) };
      return [`# ${c.primary.service}`, ...Object.entries(l).map(([k, v]) => `${k}=${v}`), `swarmy.db.cluster=${c.name}`].join('\n');
    })
    .concat(caches.map((c) => `# ${c.primary.service}\nswarmy.cache.engine=${c.engine}\nswarmy.cache.topology=${c.topology}\nswarmy.cache.memoryMb=${c.memoryMb}`))
    .join('\n\n');

  return (
    <CodeView
      title="This tab as code"
      source="yaml"
      tabs={[
        { label: 'swarmy.yaml', code: withHeader(`swarmy.yaml · the ${stack} data block`, toYaml({ resources })) },
        { label: 'labels', code: withHeader('rendered Docker labels (what the reconcile workers read)', labels || '# no managed data yet') },
        { label: 'CLI', code: `# after committing swarmy.yaml\nswarmy check\nswarmy deploy --app ${stack}` },
      ]}
    />
  );
}
