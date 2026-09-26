import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlreadyOn, type AlreadyOnItem } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { DeployDomain } from './deploy-steps';

const hhmm = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const day = (iso: string): string => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

/**
 * "Already on — change any of it": only what is really on for this new app,
 * each line a link to where you change it. Backups from the app's default-on
 * coverage (`backups.autoCoverage`), alerts from the org's channels
 * (`alerts.overview`, as the Overview's estate line), HTTPS from its route.
 */
export function LiveAlreadyOn({ stack, domain }: { stack: string; domain: DeployDomain | null }): React.JSX.Element | null {
  const trpc = useTRPC();
  const coverage = useQuery(trpc.backups.autoCoverage.queryOptions({ stack }));
  const alerts = useQuery(trpc.alerts.overview.queryOptions());
  if (coverage.isPending || alerts.isPending) return null;

  const items: AlreadyOnItem[] = [];
  const c = coverage.data;
  const covered = c && !c.appOptedOut ? [...c.databases, ...(c.volumes ?? [])].filter((x) => x.status === 'auto' || x.status === 'user') : [];
  if (c?.destination && covered.length) {
    const next = covered.map((x) => x.nextRunAt).find(Boolean);
    items.push({
      what: 'Backups',
      detail: `nightly${next ? ` at ${hhmm(next)}` : ''} to ${c.destination.name}`,
      to: `/stacks/${stack}/backups`,
    });
  }
  const channels = alerts.data?.channels ?? 0;
  if (channels) {
    items.push({ what: 'Alerts', detail: `to ${channels} channel${channels === 1 ? '' : 's'} if it goes down`, to: '/alerts' });
  }
  if (domain && domain.tls !== 'off' && domain.status?.certificate) {
    const exp = domain.status.certificate.expiresAt;
    items.push({ what: 'HTTPS', detail: `renews itself${exp ? `, well before ${day(exp)}` : ''}`, to: `/stacks/${stack}/network` });
  }
  return items.length ? <AlreadyOn title="Already on — change any of it" items={items} /> : null;
}
