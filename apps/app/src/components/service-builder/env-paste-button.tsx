import * as React from 'react';
import { ClipboardPasteIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { EnvPasteDialog } from '@/components/env/env-paste-dialog';

interface EnvPasteButtonProps {
  current: Record<string, string>;
  onApply: (next: Record<string, string>) => void;
}

/** "Paste .env" for the builder's env map (compose allows any key shape). */
export function EnvPasteButton({ current, onApply }: EnvPasteButtonProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ClipboardPasteIcon className="size-4" /> Paste .env
      </Button>
      <EnvPasteDialog
        open={open}
        onOpenChange={setOpen}
        current={current}
        onApply={(next) => {
          onApply(next);
          setOpen(false);
        }}
      />
    </div>
  );
}
