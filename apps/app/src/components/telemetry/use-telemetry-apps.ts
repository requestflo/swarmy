import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

export interface TelemetryApp {
  id: string;
  name: string;
  serviceCount: number;
  /** null while its label read is pending. */
  on: boolean | null;
}

const SYSTEM_STACK = 'swarmy-system';

/**
 * Every app with its telemetry opt-in (the live `swarmy.otel.enabled` label,
 * via `observability.stackTelemetry`), plus the switch that flips it.
 */
export function useTelemetryApps(): {
  apps: TelemetryApp[] | undefined;
  onCount: number;
  toggle: (app: TelemetryApp, on: boolean) => void;
  pending: string | null;
  error: string | null;
} {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  const list = (stacks.data ?? []).filter((s) => s.name !== SYSTEM_STACK);
  const states = useQueries({
    queries: list.map((s) => trpc.observability.stackTelemetry.queryOptions({ stack: s.name })),
  });
  const flip = useMutation(
    trpc.observability.enableForStack.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.observability.stackTelemetry.queryKey() }),
    }),
  );
  const apps = stacks.data
    ? list.map((s, i) => ({ id: s.id, name: s.name, serviceCount: s.serviceCount, on: states[i]?.data?.enabled ?? null }))
    : undefined;
  return {
    apps,
    onCount: (apps ?? []).filter((a) => a.on).length,
    toggle: (app, on) => flip.mutate({ stackId: app.name, enabled: on }),
    pending: flip.isPending ? (flip.variables?.stackId ?? null) : null,
    error: flip.error ? flip.error.message : null,
  };
}
