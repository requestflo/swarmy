import * as React from 'react';
import { CodeView, toYaml } from '@/components/calm';
import type { EstateData } from './use-estate-data';

const KIND_TYPE = { Postgres: 'postgres', Cache: 'cache', Search: 'search', Vectors: 'vector', Bucket: 'bucket' } as const;

/** All data as code: each app's swarmy.yaml resources, and the live backup facts (read-only). */
export function EstateDataCode({ d }: { d: EstateData }): React.JSX.Element {
  const yaml = d.apps
    .filter((a) => a !== 'Shared')
    .map((app) => {
      const resources: Record<string, Record<string, unknown>> = {};
      for (const i of d.items.filter((x) => x.app === app)) {
        const pg = d.pgRows.find((r) => r.stack === app && r.cluster === i.name);
        resources[i.name] = {
          type: KIND_TYPE[i.kind],
          ...(pg?.scheduled ? { backups: { schedule: pg.cron ?? 'daily', keep: pg.retentionDays ?? 7 } } : {}),
        };
      }
      return `# ${app}/swarmy.yaml\n${toYaml({ app, resources } as never)}`;
    })
    .join('\n\n');
  const live = JSON.stringify(
    d.pgRows.map((r) => ({ stack: r.stack, cluster: r.cluster, scheduled: r.scheduled, cron: r.cron, lastBackupAt: r.lastBackupAt, lastStatus: r.lastStatus, target: r.targetName })),
    null,
    2,
  );
  return (
    <CodeView
      tabs={[
        { label: 'swarmy.yaml', code: yaml || '# no data resources yet' },
        { label: 'Backups (live)', code: live },
      ]}
      note="Data lives in each app's swarmy.yaml (resources); saving opens a pull request. The backup facts are read-only: what swarmy sees right now."
    />
  );
}
