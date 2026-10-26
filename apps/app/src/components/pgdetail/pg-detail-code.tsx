import * as React from 'react';
import { CodeView, toYaml, withHeader } from '@/components/calm';
import { encodePoolerConfig } from '@swarmy/core';
import type { PgMode } from './pg-topology';
import type { PgDetailData } from './use-pg-detail';
import { usePgPooler } from './use-pg-pooler';

type Yaml = Parameters<typeof toYaml>[0];

/** The database as swarmy.yaml (at the picked shape), its rendered labels and the CLI. */
export function PgDetailCode({ stack, d, mode }: { stack: string; d: PgDetailData; mode: PgMode }): React.JSX.Element {
  const c = d.cluster!;
  const pooler = usePgPooler(stack, c.name).view?.declared ?? null;
  const replicas = mode === 'single' ? 0 : mode === c.topology ? c.replicas.desired : Math.max(1, c.replicas.desired);
  const resources: Record<string, Yaml> = {
    [c.name]: {
      type: 'postgres',
      ha: mode,
      replicas,
      regions: mode === 'geo' && c.regionReplicas ? c.regionReplicas : undefined,
      backups: d.backup?.cron ? { schedule: d.backup.cron, keep: d.backup.retentionDays ?? 7 } : undefined,
    },
  };
  if (d.pgvector?.enabled) resources[`${c.name}-vectors`] = { type: 'vector', engine: 'pgvector', on: c.name };
  const labels = [
    `# ${c.primary.service}`,
    `swarmy.db.cluster=${c.name}`,
    `swarmy.db.topology=${mode}`,
    `swarmy.db.replicas=${replicas}`,
    ...(c.writeRegion ? [`swarmy.db.writeRegion=${c.writeRegion}`] : []),
    ...Object.entries(c.regionReplicas ?? {}).map(([r, n]) => `swarmy.db.region.${r}.replicas=${n}`),
    ...(c.memoryMb ? [`swarmy.db.memoryMb=${c.memoryMb}`] : []),
    ...(pooler ? [`swarmy.db.pooler=${encodePoolerConfig(pooler)}`] : []),
    ...(d.pgvector?.enabled ? ['swarmy.vector.pgvector=true'] : []),
  ].join('\n');
  return (
    <CodeView
      title="This database as code"
      source="yaml"
      tabs={[
        { label: 'swarmy.yaml', code: withHeader(`swarmy.yaml · ${stack}’s ${c.name} database`, toYaml({ resources })) },
        { label: 'labels', code: withHeader('rendered Docker labels (what manageddb-reconcile reads)', labels) },
        { label: 'CLI', code: `# after committing swarmy.yaml\nswarmy check\nswarmy deploy --app ${stack}` },
      ]}
    />
  );
}
