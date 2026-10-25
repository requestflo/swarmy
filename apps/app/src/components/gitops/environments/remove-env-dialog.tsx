import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Input,
  toast,
} from '@swarmy/ui';
import { Segmented } from '@/components/service-settings/settings-row';
import { useTRPC } from '@/integrations/trpc';
import type { AppEnvironment } from '../gitops-types';
import { envLabel } from '../plan-status';
import { REMOVE_DATA_OPTIONS, removedWords, removeEnvSteps, type RemoveDataChoice } from './remove-env-model';

interface RemoveEnvDialogProps {
  env: AppEnvironment;
  /** Its addresses right now (the lane's domains), named in what goes; undefined while loading. */
  hosts?: readonly string[] | undefined;
  onRemoved?: () => void;
}

/**
 * "Remove environment" on a cloned environment's lane (board Environments):
 * what goes and what stays, keep-or-delete its data (keep by default: its
 * database keeps running, its volumes stay marked left over), then type its
 * stack name. Runs `apps.removeEnvironment` — `stack.remove`, audited.
 * Environments swarmy.yaml names never show this: the file removes them.
 */
export function RemoveEnvDialog({ env, hosts, onRemoved }: RemoveEnvDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [data, setData] = React.useState<RemoveDataChoice>('keep');
  const [confirm, setConfirm] = React.useState('');
  const name = envLabel(env.environment);
  const remove = useMutation(
    trpc.apps.removeEnvironment.mutationOptions({
      onSuccess: (r) => {
        toast.success(removedWords(r));
        void qc.invalidateQueries();
        onRemoved?.();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const reset = (open: boolean): void => {
    if (open) return;
    setConfirm('');
    setData('keep');
  };

  return (
    <AlertDialog onOpenChange={reset}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-tone-bad pointer-coarse:min-h-11" disabled={remove.isPending}>
          <Trash2Icon className="size-3.5" /> {remove.isPending ? 'Removing…' : 'Remove environment'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>It lives in the dashboard, so this is the only thing that removes it.</AlertDialogDescription>
        </AlertDialogHeader>
        <ul aria-label="What removing it does" className="flex flex-col gap-1.5">
          {removeEnvSteps(env, data, hosts).map(([t, m]) => (
            <li key={t} className="flex flex-col gap-0.5 text-[13px]">
              <span className={t.startsWith('Its data is deleted') ? 'text-tone-bad' : undefined}>{t}</span>
              <span className="text-muted-foreground font-mono text-[11px] break-words">{m}</span>
            </li>
          ))}
        </ul>
        <Segmented label="Its data" options={REMOVE_DATA_OPTIONS} value={data} onChange={setData} />
        <label className="flex flex-col gap-1.5 text-sm">
          <span>
            Type <span className="mono-data text-foreground">{env.stack}</span> to confirm.
          </span>
          <Input autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={env.stack} className="font-mono" />
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep {name}</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirm !== env.stack || remove.isPending}
            onClick={() => remove.mutate({ stack: env.stack, confirm, data })}
          >
            {data === 'delete' ? `Remove ${name} and its data` : `Remove ${name}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
