import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { listWords } from './connections-model';

/**
 * "web isn't attached, so it can't reach checkout": attach wires the
 * database's DATABASE_URL into that service (`db.inject`), which restarts it
 * once, rolling. Several unattached services get a picker, not a button each.
 */
export function AttachDbLine({ stack, cluster, services }: { stack: string; cluster: string; services: string[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const id = React.useId();
  const [pick, setPick] = React.useState(services[0] ?? '');
  const [done, setDone] = React.useState<string | null>(null);
  const inject = useMutation(
    trpc.db.inject.mutationOptions({
      onSuccess: (r, v) => {
        setDone(`${v.appService.replace(`${stack}_`, '')} attached · ${r.envVar} wired · it restarts once, rolling`);
        void qc.invalidateQueries();
      },
    }),
  );
  const target = services.includes(pick) ? pick : (services[0] ?? '');
  const many = services.length > 1;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5 text-[12px]">
      {done ? (
        <span role="status" className="text-tone-ok">
          {done}
        </span>
      ) : (
        <span className="text-muted-foreground">
          {listWords(services)} {many ? 'aren’t' : 'isn’t'} attached, so {many ? 'they' : 'it'} can’t reach {cluster}. Attach to wire DATABASE_URL.
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {many ? (
          <>
            <label htmlFor={id} className="sr-only">
              Service to attach to {cluster}
            </label>
            <select
              id={id}
              value={target}
              onChange={(ev) => setPick(ev.target.value)}
              className="border-border bg-background h-7 rounded-[8px] border px-2 font-mono text-xs pointer-coarse:min-h-11"
            >
              {services.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs pointer-coarse:min-h-11"
          disabled={inject.isPending || !target}
          onClick={() => inject.mutate({ stack, cluster, appService: `${stack}_${target}` })}
        >
          {inject.isPending ? 'Attaching…' : many ? 'Attach' : `Attach ${target}`}
        </Button>
      </span>
      {inject.error ? (
        <span role="alert" className="text-tone-bad w-full">
          {inject.error.message}
        </span>
      ) : null}
    </div>
  );
}
