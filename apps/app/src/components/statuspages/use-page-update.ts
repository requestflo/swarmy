import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** `statusPages.update` with the house toast + refresh (every knob on the page saves through it). */
export function usePageUpdate(done = 'Saved — visitors see it within 30 seconds.') {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return useMutation(
    trpc.statusPages.update.mutationOptions({
      onSuccess: () => {
        toast.success(done);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
}
