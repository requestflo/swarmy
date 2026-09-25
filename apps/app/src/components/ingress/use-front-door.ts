import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { IngressDriverId } from './driver-config';

/** The Front door page's data and its four mutations (moved from the route, logic unchanged). */
export function useFrontDoor() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  // Poll: runtime (controller tasks + last apply) converges after a change.
  const config = useQuery({ ...trpc.ingress.getConfig.queryOptions(), refetchInterval: 5000 });
  const domains = useQuery(trpc.ingress.listDomains.queryOptions());
  const driver = (config.data?.driver ?? 'none') as IngressDriverId;
  const preview = useQuery({ ...trpc.ingress.previewConfig.queryOptions({}), enabled: config.isSuccess && driver !== 'none' });

  const invalidate = (): void => void qc.invalidateQueries();
  // A config write can succeed while the edge fails to come up — say so.
  const afterEdgeChange = (view: { runtime: { state: string; message: string }; dashboardWarning?: string | null }): void => {
    if (view.runtime.state === 'down' || view.runtime.state === 'degraded') toast.error(view.runtime.message);
    // Leaving Caddy (or disabling) stops serving the dashboard's https address.
    if (view.dashboardWarning) toast.error(view.dashboardWarning);
    invalidate();
  };
  const onError = (e: { message: string }): void => void toast.error(e.message);
  const setDriver = useMutation(trpc.ingress.setDriver.mutationOptions({ onSuccess: afterEdgeChange, onError }));
  const setEnabled = useMutation(trpc.ingress.setEnabled.mutationOptions({ onSuccess: afterEdgeChange, onError }));
  const setTunnel = useMutation(
    trpc.ingress.setTunnel.mutationOptions({
      onSuccess: () => {
        toast.success('Cloudflare tunnel updated');
        invalidate();
      },
      onError,
    }),
  );
  const setOnDemandTls = useMutation(
    trpc.ingress.setOnDemandTls.mutationOptions({
      onSuccess: () => {
        toast.success('On-demand TLS updated');
        invalidate();
      },
      onError,
    }),
  );
  return { config, domains, preview, driver, setDriver, setEnabled, setTunnel, setOnDemandTls };
}
