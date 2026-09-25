import * as React from 'react';
import { CodeView, type CodeTab } from '@/components/calm';
import { isKvEngine, type StudioTableView, type StudioTargetView } from './studio-types';

/** Code depth of the studio: the same read as SQL, and a shell on your laptop with the app's env. */
export function StudioCode({
  stack,
  target,
  table,
}: {
  stack: string;
  target: StudioTargetView;
  table: StudioTableView | null;
}): React.JSX.Element {
  const kv = isKvEngine(target.engine);
  const tabs: CodeTab[] = [];
  if (!kv && table) {
    const ref = `"${table.schema ?? 'public'}"."${table.name}"`;
    const key = table.keyColumns?.[0];
    tabs.push({ label: 'SQL', code: `-- what the Data grid runs (read-only, row limit applies)\nSELECT * FROM ${ref}${key ? ` ORDER BY "${key}" DESC` : ''} LIMIT 50;` });
  }
  if (target.kind === 'managed' && target.engine === 'postgres') {
    tabs.push({
      label: 'CLI',
      code: `# a psql on your laptop, with the app's env (DATABASE_URL is injected)\nswarmy run --app ${stack} -- psql "$DATABASE_URL"\n\n# read-only against the standby copy\nswarmy run --app ${stack} -- psql "$DATABASE_RO_URL"`,
    });
  }
  if (kv) tabs.push({ label: 'CLI', code: `# the same keys from a shell with the app's env\nswarmy run --app ${stack} -- sh -c 'redis-cli -u "$REDIS_URL" --scan | head'` });
  if (tabs.length === 0) tabs.push({ label: 'target', code: `# ${target.name}\nengine: ${target.engine}\nservice: ${target.service}\nimage: ${target.image}` });
  return (
    <CodeView
      tabs={tabs}
      source="readonly"
      note="Studio queries run through the agent on the database’s server, never a public port, and every one is audited. There is no REST endpoint for them."
    />
  );
}
