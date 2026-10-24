import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

const LIVE = new Set(['running', 'abandoning']);

/** Settings → Platform status; polls fast while a run is live (or being put back), steadily while paused. */
export function usePlatformStatus() {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.platform.status.queryOptions(),
    refetchInterval: (q) => {
      const s = q.state.data?.run?.status;
      return s && LIVE.has(s) ? 3_000 : s === 'paused' ? 15_000 : 60_000;
    },
  });
}

export function useIsPlatformAdmin(): boolean {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  return org.data?.role === 'owner' || org.data?.role === 'admin';
}

export const STEP_TEXT: Record<string, { name: string; what: string; ifFails: string }> = {
  preflight: {
    name: 'Preflight',
    what: 'Every server online, swarm quorum, disk headroom, a fresh controller backup, images copied into the cluster',
    ifFails: 'nothing changed yet',
  },
  controller: {
    name: 'Controller',
    what: 'Restarts itself on the new build, then picks this upgrade back up',
    ifFails: 'Swarm rolls the image back',
  },
  agents: { name: 'Agents', what: 'One server at a time, confirmed by the reconnect', ifFails: 'container agents go back to the previous build' },
  system: {
    name: 'System services',
    what: 'swarmy-dns → Caddy edges → observability, each health-checked',
    ifFails: 'previous image restored per service',
  },
  mesh: {
    name: 'Private network',
    what: "Each server's private-network client, one server at a time, only while another server stays on it, confirmed by it reconnecting",
    ifFails: 'that server puts its old client back itself; the ones already moved go back too',
  },
  engines: {
    name: 'Engine upgrades',
    what: 'Object storage: a minor update goes one member at a time, healthy in between; a major takes a snapshot and a brief pause',
    ifFails: 'every member back on the old version (a major restores its snapshot)',
  },
  verify: {
    name: 'Verify',
    what: 'Every server back, every system service converged, and a test request through every front door reaches swarmy',
    ifFails: 'the run stops and says which front door failed',
  },
};

export const NOTE_VARIANT: Record<string, 'info' | 'success' | 'muted' | 'warning' | 'destructive'> = {
  new: 'info',
  better: 'success',
  fix: 'muted',
  security: 'warning',
  breaking: 'destructive',
};

export function shortDigest(d: string | null | undefined): string {
  return d ? d.replace(/^sha256:/, '').slice(0, 12) : '—';
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getTime() === 0 ? '—' : d.toLocaleString();
}

export type PlatformStatus = NonNullable<ReturnType<typeof usePlatformStatus>['data']>;
export type PlatformAvailable = NonNullable<PlatformStatus['release']['available']>;
export type PlatformRun = NonNullable<PlatformStatus['run']>;
