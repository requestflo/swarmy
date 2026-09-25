import * as React from 'react';
import { AlreadyOn, type AlreadyOnItem } from '@/components/calm';
import type { SetupFacts } from './use-setup-facts';

/** "Already on" for the estate: only what is really on, each line a link to change it. */
export function estateAlreadyOn(f: SetupFacts, x: { channels: number; servers: number }): AlreadyOnItem[] {
  const out: AlreadyOnItem[] = [];
  const t = f.backupTargets;
  if (t.length) {
    out.push({ what: 'Backups', detail: `nightly, to ${t.length === 1 ? t[0]!.name : `${t.length} places`}`, to: '/backups' });
  }
  if (x.channels) {
    out.push({ what: 'Alerts', detail: `to ${x.channels} channel${x.channels === 1 ? '' : 's'} if anything goes down`, to: '/alerts' });
  }
  if (f.domainCount) {
    out.push({ what: 'HTTPS', detail: `${f.domainCount} domain${f.domainCount === 1 ? '' : 's'}, renews itself`, to: '/network' });
  }
  if (f.meshOn) {
    out.push({
      what: 'Private network',
      detail: f.meshPeers >= x.servers ? `all ${x.servers} servers, no open ports` : `${f.meshPeers} of ${x.servers} servers`,
      to: '/networking',
    });
  }
  return out;
}

export function EstateAlreadyOn({ items }: { items: AlreadyOnItem[] }): React.JSX.Element | null {
  return items.length ? <AlreadyOn items={items} /> : null;
}
