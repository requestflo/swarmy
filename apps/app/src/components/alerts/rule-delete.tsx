import * as React from 'react';
import { Button } from '@swarmy/ui';

interface RuleDeleteProps {
  name: string;
  isDefault: boolean;
  pending: boolean;
  onConfirm: () => void;
}

/** Remove a rule behind an in-page confirm (the viewer has no confirm() dialog). */
export function RuleDelete({ name, isDefault, pending, onConfirm }: RuleDeleteProps): React.JSX.Element {
  const [asking, setAsking] = React.useState(false);
  if (!asking) {
    return (
      <Button variant="ghost" size="sm" className="text-muted-foreground w-fit self-start pointer-coarse:min-h-11" onClick={() => setAsking(true)}>
        Delete rule
      </Button>
    );
  }
  return (
    <div role="group" aria-label={`Delete ${name}?`} className="border-border flex w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
      <span className="text-sm">
        {isDefault
          ? `Delete ${name}? It’s built in, so it stays gone for good. Turning it off keeps it for later.`
          : `Delete ${name}? swarmy stops watching this.`}
      </span>
      <span className="ml-auto flex gap-2">
        <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => setAsking(false)}>
          Keep it
        </Button>
        <Button variant="destructive" size="sm" className="pointer-coarse:min-h-11" disabled={pending} onClick={onConfirm}>
          {pending ? 'Deleting…' : 'Delete'}
        </Button>
      </span>
    </div>
  );
}
