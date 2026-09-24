import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Secret app variables for one service: metadata (never values), set/rotate,
 * remove, and the audited reveal. A revealed value lives only in component
 * state, is dropped after 30s, and is never written to the query cache.
 */
export function useSecretVars(serviceId: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const vars = useQuery({ ...trpc.services.secretVars.queryOptions({ id: serviceId }), refetchInterval: 15_000 });
  const [revealed, setRevealed] = React.useState<{ key: string; value: string } | null>(null);

  React.useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 30_000);
    return () => clearTimeout(t);
  }, [revealed]);

  const refresh = (): void => void qc.invalidateQueries();
  const set = useMutation(
    trpc.services.setSecretVar.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.rotated ? `Saved as v${r.version} — rolling out` : 'Delivery updated — rolling out');
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.services.removeSecretVar.mutationOptions({
      onSuccess: () => {
        toast.success('Secret removed — rolling out');
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const reveal = useMutation(
    trpc.services.revealSecretVar.mutationOptions({
      onSuccess: (r) => setRevealed({ key: r.key, value: r.value }),
      onError: (e) => toast.error(e.message),
    }),
  );

  return { vars, set, remove, reveal, revealed, hide: () => setRevealed(null) };
}
