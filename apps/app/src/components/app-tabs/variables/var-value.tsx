import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { maskValue } from '@swarmy/core';
import { Button, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { TableRow } from './var-table-model';

const MASK = '••••••••••••';
const btn = 'h-7 px-2 text-xs pointer-coarse:min-h-11';

/**
 * The value cell. Plain values show as they are; a password-looking plain
 * value is masked with a local Reveal (anyone who reads the app's settings
 * can see it already). A secret variable reveals through
 * `services.revealSecretVar` — `secrets.read`, audited. Secret families are
 * write-only: no reveal, ever.
 */
export function VarValue({ row }: { row: TableRow }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [shown, setShown] = React.useState<string | null>(null);
  const target = row.targets?.[0];
  const reveal = useMutation(
    trpc.services.revealSecretVar.mutationOptions({
      onSuccess: (r) => {
        setShown(r.value);
        void qc.invalidateQueries({ queryKey: trpc.audit.list.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  let text: string;
  let action: React.ReactNode = null;
  if (row.kind === 'family') {
    text = MASK;
  } else if (row.kind === 'secretVar') {
    text = shown ?? MASK;
    action = shown ? (
      <Button variant="ghost" size="sm" className={btn} onClick={() => setShown(null)}>Hide</Button>
    ) : (
      <Button
        variant="outline"
        size="sm"
        className={btn}
        disabled={!target || reveal.isPending}
        title={target ? `Reads it from a running ${target.name} copy · on the audit log` : undefined}
        onClick={() => target && reveal.mutate({ id: target.id, key: row.key })}
      >
        {reveal.isPending ? 'Reading…' : 'Reveal'}
      </Button>
    );
  } else if (row.value === null) {
    text = 'differs by service — pick one above';
  } else if (row.secretLooking) {
    text = shown ?? maskValue(row.value);
    action = (
      <Button variant="ghost" size="sm" className={btn} onClick={() => setShown(shown ? null : row.value)}>
        {shown ? 'Hide' : 'Reveal'}
      </Button>
    );
  } else {
    text = row.value;
  }

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'min-w-0 truncate font-mono text-[12.5px]',
          row.value === null && row.kind !== 'family' && row.kind !== 'secretVar' && 'text-muted-foreground font-sans',
          shown !== null && 'text-foreground font-semibold',
        )}
      >
        {text}
      </span>
      {row.secretLooking && !shown ? <span className="text-tone-warn shrink-0 text-xs">looks like a password</span> : null}
      {action}
    </span>
  );
}
