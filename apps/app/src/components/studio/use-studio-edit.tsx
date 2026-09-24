import { useMutation } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { useStudioRun } from './use-studio-run';
import type { StudioEdit, StudioRunView, StudioScope } from './studio-types';

/**
 * A grid edit: the server BUILDS the exact statement (`studio.prepareEdit`),
 * the confirm dialog shows it, then it runs like any console write.
 */
export function useStudioEdit(scope: StudioScope, onApplied: (r: StudioRunView) => void) {
  const trpc = useTRPC();
  const { run, dialog, running } = useStudioRun(scope, (r) => {
    toast.success(r.affected != null ? `${r.affected} row${r.affected === 1 ? '' : 's'} changed` : 'Applied');
    onApplied(r);
  });
  const prepare = useMutation(
    trpc.studio.prepareEdit.mutationOptions({
      onSuccess: (p) => run(p.display, 'edit'),
      onError: (e) => toast.error(e.message),
    }),
  );
  const edit = (e: StudioEdit) => {
    if (!scope.unlocked) {
      toast.error('Read-only — unlock writes first (needs data.write).');
      return;
    }
    prepare.mutate({ stack: scope.stack, target: scope.target.name, edit: e });
  };
  return { edit, dialog, busy: running || prepare.isPending };
}
