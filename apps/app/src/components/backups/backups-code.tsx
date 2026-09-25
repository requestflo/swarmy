import * as React from 'react';
import { CodeView, curl, restExchange, toYaml } from '@/components/calm';
import type { TargetRow } from './destinations-card';

/** Backups as code: destinations over REST, and a database's backups in swarmy.yaml. */
export function BackupsCode({ targets }: { targets: TargetRow[] }): React.JSX.Element {
  const list = restExchange('GET', '/backup-targets', {
    data: targets.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind.toLowerCase(),
      endpoint: t.endpoint,
      bucket: t.bucket,
      prefix: t.prefix,
      has_credentials: t.hasCredentials,
      enabled: t.enabled,
    })),
    next_cursor: null,
  });
  const add = curl('POST', '/backup-targets', {
    name: 'offsite',
    kind: 's3',
    endpoint: 's3.eu-central-003.backblazeb2.com',
    bucket: 'my-backups',
    access_key_id: '$KEY_ID',
    secret_access_key: '$SECRET',
    restic_password: '$RESTIC_PASSWORD',
  });
  const yaml = `# in an app's swarmy.yaml — a database's own schedule\n${toYaml({ resources: { db: { type: 'postgres', backups: { schedule: 'daily', keep: 14 } } } })}`;
  return (
    <CodeView
      tabs={[
        { label: 'REST', code: `${list}\n\n# add an off-site destination\n${add}` },
        { label: 'swarmy.yaml', code: yaml },
      ]}
      note="Destinations are a dashboard setting; the same calls work over REST. What each app saves lives in its swarmy.yaml."
    />
  );
}
