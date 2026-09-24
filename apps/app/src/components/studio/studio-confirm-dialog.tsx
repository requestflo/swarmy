import * as React from 'react';
import { ShieldAlertIcon } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, cn } from '@swarmy/ui';
import { CLASS_TONE, type Verdict } from './studio-verdict';

interface StudioConfirmDialogProps {
  verdict: Verdict | null;
  /** The database name — typed back for a destructive statement. */
  phrase: string;
  pending: boolean;
  error: string | null;
  onConfirm: (typed: string | undefined) => void;
  onCancel: () => void;
}

/** Every write shows the exact statement before it applies; destructive ones need the name typed back. */
export function StudioConfirmDialog({ verdict, phrase, pending, error, onConfirm, onCancel }: StudioConfirmDialogProps): React.JSX.Element {
  const [typed, setTyped] = React.useState('');
  React.useEffect(() => setTyped(''), [verdict]);
  const destructive = verdict?.classification.class === 'destructive';
  const ready = !destructive || typed.trim() === phrase;
  return (
    <Dialog open={Boolean(verdict)} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className={cn('size-5', destructive ? 'text-status-offline' : 'text-status-warning')} />
            {destructive ? 'Destructive statement' : 'Apply this write?'}
          </DialogTitle>
          <DialogDescription>
            This is exactly what runs on <span className="font-mono">{phrase}</span>, through the agent on its node. It is audited with your name.
          </DialogDescription>
        </DialogHeader>
        {verdict ? (
          <div className="space-y-3">
            <pre className="bg-muted max-h-64 overflow-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap">{verdict.display}</pre>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={cn('rounded-full px-2 py-0.5 font-mono font-semibold', CLASS_TONE[verdict.classification.class])}>
                {verdict.classification.class}
              </span>
              <span className="mono-label text-muted-foreground">needs {verdict.action}</span>
              {verdict.classification.reasons.map((r) => (
                <span key={r} className="text-muted-foreground">· {r}</span>
              ))}
            </div>
            {destructive ? (
              <label className="block space-y-1.5 text-sm">
                <span>
                  Type <b className="font-mono">{phrase}</b> to confirm
                </span>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus className="font-mono" />
              </label>
            ) : null}
            {error ? <p className="text-status-offline text-sm">{error}</p> : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={!ready || pending} onClick={() => onConfirm(destructive ? typed.trim() : undefined)}>
            {pending ? 'Running…' : destructive ? 'Run destructive statement' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
