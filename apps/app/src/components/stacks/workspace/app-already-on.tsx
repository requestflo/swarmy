import * as React from 'react';
import { AlreadyOn, type AlreadyOnItem } from '@/components/calm';
import type { AppFacts } from './use-app-facts';

/** What this app already has, from live labels and settings — never a promise. */
export function appAlreadyOn(stack: string, f: AppFacts): AlreadyOnItem[] {
  const out: AlreadyOnItem[] = [
    // Swarm services restart failed tasks by default (restart_policy: any).
    { what: 'Restarts', detail: 'itself if a part crashes' },
  ];
  const base = `/stacks/${stack}`;
  if (f.safety?.enabled) {
    out.push({
      what: 'Safe deploys',
      detail: `each change is watched for ${Math.round(f.safety.windowSec / 60) || 1} min${f.safety.autoRollback ? ' and put back if it fails' : ''}`,
      to: `${base}/releases`,
    });
  }
  const https = (f.domains ?? []).filter((d) => d.serving && (d.tls === 'auto' || d.tls === 'custom'));
  if (https.length) out.push({ what: 'HTTPS', detail: `${https.length} address${https.length === 1 ? '' : 'es'}, renews itself`, to: `${base}/network` });
  if (f.coverage?.destination && !f.coverage.appOptedOut && ((f.coverage.databases?.length ?? 0) || (f.coverage.volumes?.length ?? 0))) {
    out.push({ what: 'Backups', detail: `nightly, to ${f.coverage.destination.name}`, to: `${base}/backups` });
  }
  if (f.telemetry?.enabled) out.push({ what: 'Telemetry', detail: 'traces and metrics are collected', to: `${base}/observability` });
  return out;
}

export function AppAlreadyOn({ items }: { items: AlreadyOnItem[] }): React.JSX.Element {
  return <AlreadyOn items={items} />;
}
