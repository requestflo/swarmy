import * as React from 'react';
import { CodeView, toYaml } from '@/components/calm';
import type { StackBackupsData } from './use-stack-backups';

/** One app's backups as code: a database's swarmy.yaml backups, and the labels that turn default saves off. */
export function StackBackupsCode({ stack, b }: { stack: string; b: StackBackupsData }): React.JSX.Element {
  const dbs = (b.coverage?.databases ?? []).filter((d) => d.kind === 'managed');
  const yaml = dbs.length
    ? toYaml({
        resources: Object.fromEntries(
          dbs.map((d) => [d.name, { type: 'postgres', backups: { schedule: 'daily', keep: d.retentionDays ?? 7 } }]),
        ),
      } as never)
    : '# managed databases take `backups: { schedule, keep }`\n# volumes are saved nightly with nothing to write';
  const off = (b.coverage?.volumes ?? []).filter((v) => v.optOut === 'volume').map((v) => v.volume);
  const labels = [
    `# service labels swarmy reads (live)`,
    b.coverage?.appOptedOut ? 'swarmy.backup.auto=off' : '# no swarmy.backup.auto label: default nightly saves are on',
    ...(off.length ? [`swarmy.backup.auto.exclude=${off.join(',')}`] : []),
  ].join('\n');
  const live = JSON.stringify(
    {
      stack,
      destination: b.coverage?.destination?.name ?? null,
      schedules: b.scheduleRows.map((s) => ({ volume: s.volume, every: `${s.every} ${s.unit}`, paused: s.paused, keep: s.retentionDays, auto: s.auto })),
      volumes: (b.coverage?.volumes ?? []).map((v) => ({ volume: v.volume, status: v.status })),
    },
    null,
    2,
  );
  return (
    <CodeView
      tabs={[
        { label: 'swarmy.yaml', code: `# ${stack}/swarmy.yaml\n${yaml}` },
        { label: 'Labels', code: labels },
        { label: 'Live', code: live },
      ]}
      note="Database schedules live in swarmy.yaml; the default nightly saves are on unless a label turns them off. Live is read-only."
    />
  );
}
