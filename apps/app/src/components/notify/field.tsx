import * as React from 'react';
import { Input, Label } from '@swarmy/ui';

/** One labelled input with an optional hint line. */
export function Field({
  id,
  label,
  hint,
  ...input
}: {
  id: string;
  label: string;
  hint?: string;
} & React.ComponentProps<typeof Input>): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...input} />
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
