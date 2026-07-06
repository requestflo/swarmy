import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Green / amber / red DNS health.
 *
 * - `healthy`  — at least one healthy region answers for the host.
 * - `degraded` — swarmy answers but no region is healthy (degraded spill), or
 *                the public answer disagrees with what swarmy intends.
 * - `down`     — swarmy has nothing to answer with (no endpoints).
 * - `checking` — a live probe is in flight.
 * - `unknown`  — no zone covers the host / nothing to say yet.
 */
export type DnsHealth = 'healthy' | 'degraded' | 'down' | 'checking' | 'unknown';

const STYLES: Record<DnsHealth, { dot: string; text: string; label: string }> = {
  healthy: { dot: 'bg-status-online', text: 'text-status-online', label: 'healthy' },
  degraded: { dot: 'bg-status-warning', text: 'text-status-warning', label: 'degraded' },
  down: { dot: 'bg-status-offline', text: 'text-status-offline', label: 'down' },
  checking: { dot: 'bg-status-progress', text: 'text-status-progress', label: 'checking' },
  unknown: { dot: 'bg-status-idle', text: 'text-status-idle', label: 'no record' },
};

/** Shape of a `geodns.checkDomain` probe (mirrors the tRPC `DomainCheck` view). */
export interface DnsCheck {
  resolves: boolean;
  reachable: boolean;
  served: boolean;
  expectedIps: string[];
  gotIp: string;
}

/** Derive a green/amber/red health from a `geodns.checkDomain` probe. */
export function dnsHealthFromCheck(c: DnsCheck): DnsHealth {
  if (!c.resolves) return 'down';
  if (!c.reachable) return 'degraded';
  if (!c.served) return 'degraded';
  return 'healthy';
}

/** Health for one host from the derived DNS view rows (cheap, shared-cache friendly). */
function dnsHealthFromView(
  rows: Array<{ host: string; endpoints: Array<{ ip: string; healthy: boolean }>; healthyCount: number }>,
): DnsHealth {
  if (rows.length === 0) return 'unknown';
  if (rows.some((r) => r.healthyCount > 0)) return 'healthy';
  if (rows.some((r) => r.endpoints.some((e) => e.ip))) return 'degraded';
  return 'down';
}

interface DnsHealthBadgeProps {
  /** Presentational: render a known status (the caller already has the data). */
  status?: DnsHealth;
  /**
   * Self-probing: pass a host and the badge derives health from `geodns.dnsView`.
   * The query is shared/deduped across every badge, so dropping one on each canvas
   * node costs a single round-trip, not one per node.
   */
  host?: string;
  /** Override the rendered text (the dot colour still follows the status). */
  label?: string;
  /** Dot only — for tight spots like a canvas service node. */
  compact?: boolean;
  className?: string;
}

/** Status dot + label driven by the cluster status tokens (never raw palette). */
export function DnsHealthBadge({
  status,
  host,
  label,
  compact,
  className,
}: DnsHealthBadgeProps): React.JSX.Element {
  const trpc = useTRPC();
  const selfProbe = status === undefined && !!host;
  const view = useQuery({
    ...trpc.geodns.dnsView.queryOptions({}),
    enabled: selfProbe,
    staleTime: 30_000,
  });

  let resolved: DnsHealth = status ?? 'unknown';
  if (selfProbe) {
    resolved = view.isPending
      ? 'checking'
      : dnsHealthFromView((view.data ?? []).filter((r) => r.host === host));
  }

  const style = STYLES[resolved];
  const text = label ?? style.label;
  return (
    <span
      title={host ? `${host} · ${text}` : text}
      className={cn('inline-flex items-center gap-1.5 text-xs font-medium', style.text, className)}
    >
      <span className={cn('size-2 shrink-0 rounded-full', style.dot, resolved === 'checking' && 'animate-pulse')} />
      {!compact && <span>{text}</span>}
    </span>
  );
}
