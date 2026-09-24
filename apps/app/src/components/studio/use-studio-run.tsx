import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StudioConfirmDialog } from './studio-confirm-dialog';
import { errorInfo, type StudioRunView, type StudioScope } from './studio-types';
import { verdictFor, type Verdict } from './studio-verdict';

type Origin = 'console' | 'edit' | 'saved';

/**
 * Run a statement against the scope's database. Reads run straight away;
 * writes need "Unlock writes" and go through the confirm dialog (the exact
 * statement, and the name typed back when destructive). The server gates again.
 */
export function useStudioRun(scope: StudioScope | null, onDone?: (r: StudioRunView) => void) {
  const trpc = useTRPC();
  const [pending, setPending] = React.useState<{ verdict: Verdict; origin: Origin } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const exec = useMutation(trpc.studio.execute.mutationOptions());
  const pendingRef = React.useRef(pending);
  pendingRef.current = pending;

  const send = React.useCallback(
    (text: string, origin: Origin, confirm?: string) => {
      if (!scope) return;
      setError(null);
      exec.mutate(
        { stack: scope.stack, target: scope.target.name, statement: text, database: scope.database, dbIndex: scope.dbIndex, origin, ...(confirm ? { confirm } : {}) },
        {
          onSuccess: (r) => {
            setPending(null);
            onDone?.(r);
          },
          onError: (e) => {
            const info = errorInfo(e);
            if (pendingRef.current) setError(info.message);
            else toast.error(info.message);
          },
        },
      );
    },
    [scope, exec, onDone],
  );
  const run = React.useCallback(
    (text: string, origin: Origin = 'console') => {
      if (!scope) return;
      const verdict = verdictFor(scope.target.engine, text);
      if (verdict.classification.blocked) {
        toast.error(verdict.classification.blocked);
        return;
      }
      if (verdict.classification.class === 'read') return send(verdict.display, origin);
      if (!scope.unlocked) {
        toast.error(`This is a ${verdict.classification.class} — unlock writes first (needs ${verdict.action}).`);
        return;
      }
      setError(null);
      setPending({ verdict, origin });
    },
    [scope, send],
  );

  const dialog = (
    <StudioConfirmDialog
      verdict={pending?.verdict ?? null}
      phrase={scope?.target.name ?? ''}
      pending={exec.isPending}
      error={error}
      onCancel={() => setPending(null)}
      onConfirm={(typed) => pending && send(pending.verdict.display, pending.origin, typed)}
    />
  );
  return { run, dialog, result: exec.data ?? null, running: exec.isPending, error: exec.error ? errorInfo(exec.error).message : null, reset: exec.reset };
}
