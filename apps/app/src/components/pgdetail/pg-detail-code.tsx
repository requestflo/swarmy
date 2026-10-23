import * as React from 'react';
import { CodeView, Section, Tech, toYaml, withHeader } from '@/components/calm';
import { bytes } from '@/lib/format';
import type { PgMode } from './pg-topology';
import type { PgDetailData } from './use-pg-detail';

type Yaml = Parameters<typeof toYaml>[0];

/** The database as swarmy.yaml (at the picked shape), its rendered labels and the CLI. */
export function PgDetailCode({ stack, d, mode }: { stack: string; d: PgDetailData; mode: PgMode }): React.JSX.Element {
  const c = d.cluster!;
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

/** Memory the main copy uses right now (`services.usage`). */
export function PgMemorySection({ d }: { d: PgDetailData }): React.JSX.Element | null {
  const c = d.cluster!;
  if (c.primary.status !== 'running') return null;
  const u = d.usage;
  return (
    <Section title="Size">
      <p className="text-[13.5px]">
        <span className="text-muted-foreground">Memory </span>
        {u ? <b className="font-semibold">{bytes(u.memBytes.peak)} in use by the main copy</b> : <span className="text-muted-foreground">not reported yet</span>}
        {d.backup?.lastSizeBytes ? <span className="text-muted-foreground"> · the last save was {bytes(Number(d.backup.lastSizeBytes))}</span> : null}
      </p>
      {u ? <Tech>container stats · {u.sampled} {u.sampled === 1 ? 'copy' : 'copies'} sampled {new Date(u.ts).toLocaleTimeString()} · {c.primary.service}</Tech> : null}
    </Section>
  );
}
