import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CopyPlusIcon } from 'lucide-react';
import { Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, toast } from '@swarmy/ui';
import { StatusWord, toneFromStatus } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { findStackApp, type AppEnvironment, type GitApp } from '../gitops-types';
import { envLabel, planStatus } from '../plan-status';
import { CloneEnvForm, type CloneRequest } from './clone-env-form';
import { SecretSlots } from './secret-slots';

/**
 * Clone as a new environment (board Environments): the sheet asks for a name,
 * a branch and how its database starts, then runs `apps.cloneEnvironment` —
 * the same engine as a push — and asks for each secret, write-only, because
 * none are copied. The new environment lives in the dashboard until
 * swarmy.yaml names it.
 */
export function CloneEnvSheet({ app, from }: { app: GitApp; from: AppEnvironment }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [made, setMade] = React.useState<{ stack: string; name: string; status: string; reason?: string } | null>(null);
  const clone = useMutation(
    trpc.apps.cloneEnvironment.mutationOptions({
      onError: (e) => toast.error(e.message),
      onSuccess: (r, v) => {
        setMade({ stack: r.stack ?? `${app.appName}-${v.name}`, name: v.name, status: r.status, ...(r.reason ? { reason: r.reason } : {}) });
        void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
      },
    }),
  );
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), enabled: !!made, refetchInterval: made ? 5_000 : false });
  const env = made && apps.data ? findStackApp(apps.data, made.stack) : null;
  const slots = env?.kind === 'env' ? env.env.dashboard?.secretSlots : undefined;
  const onOpen = (next: boolean): void => {
    setOpen(next);
    if (!next) setMade(null);
  };
  const submit = (r: CloneRequest): void => clone.mutate({ stack: from.stack, ...r });
  const st = made ? planStatus(made.status) : null;

  return (
    <Sheet open={open} onOpenChange={onOpen}>
      <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => onOpen(true)}>
        <CopyPlusIcon className="size-3.5" /> Clone as new environment
      </Button>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <span className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">{`From ${envLabel(from.environment).toLowerCase()} · ${from.stack}`}</span>
          <SheetTitle>Clone as a new environment</SheetTitle>
          <SheetDescription>
            The same app from a branch, with its own copy of everything and none of {from.environment}’s domains or secrets. It’s long-lived — not a preview, so nothing tears it down.
          </SheetDescription>
        </SheetHeader>
        {!made ? (
          <CloneEnvForm app={app} from={from} pending={clone.isPending} onClone={submit} />
        ) : (
          <div className="flex flex-col gap-4 px-4 pb-8">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-[15px] font-bold">{envLabel(made.name)}</span>
              {st ? <StatusWord tone={toneFromStatus(st.tone)} word={st.label} /> : null}
              <Link to="/stacks/$name/releases" params={{ name: made.stack }} className="text-muted-foreground font-mono text-[11px] hover:underline">
                {made.stack}
              </Link>
            </div>
            {made.reason ? <p className="text-muted-foreground text-xs">{made.reason}</p> : null}
            <p className="text-tone-info text-[13px]">Lives in the dashboard until you add it to swarmy.yaml.</p>
            <h3 className="font-display text-[14px] font-bold">Its secrets</h3>
            {slots ? <SecretSlots stack={made.stack} env={made.name} slots={slots} /> : <TextSkeleton className="h-4 w-1/2" />}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
