import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/** Settings → Platform status; polls fast while a run is live. */
export function usePlatformStatus() {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.platform.status.queryOptions(),
    refetchInterval: (q) => (q.state.data?.run?.status === 'running' ? 3_000 : 60_000),
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
  engines: {
    name: 'Engine upgrades',
    what: 'Garage major version: snapshot, a brief pause, all members together',
    ifFails: 'snapshot restored on the old version',
  },
  verify: { name: 'Verify', what: 'Every server back, every system service converged', ifFails: 'the run stops and says why' },
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
