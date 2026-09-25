import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/**
 * The reads behind the app Overview's aside (facts, already on, worth doing,
 * code). Each part fills in when it lands; nothing here gates the canvas.
 */
export function useAppFacts(stack: string) {
  const trpc = useTRPC();
  const domains = useQuery({ ...trpc.ingress.listDomains.queryOptions({ stack }), refetchInterval: 15_000 });
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ stackName: stack, limit: 5 }), refetchInterval: 15_000 });
  const coverage = useQuery(trpc.backups.autoCoverage.queryOptions({ stack }));
  const telemetry = useQuery(trpc.observability.stackTelemetry.queryOptions({ stack }));
  const safety = useQuery(trpc.releases.getSafety.queryOptions({ stackName: stack }));
  const resilience = useQuery(trpc.resilience.overview.queryOptions({ stack }));
  const members = useQuery(trpc.members.list.queryOptions());
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  return {
    domains: domains.data,
    releases: releases.data,
    coverage: coverage.data,
    telemetry: telemetry.data,
    safety: safety.data,
    problems: resilience.data?.ready ? resilience.data.problems : undefined,
    members: members.data,
    stackId: stacks.data?.find((s) => s.name === stack)?.id ?? null,
    settled: [domains, releases, coverage, telemetry, safety, resilience].every((q) => !q.isPending),
  };
}

export type AppFacts = ReturnType<typeof useAppFacts>;
