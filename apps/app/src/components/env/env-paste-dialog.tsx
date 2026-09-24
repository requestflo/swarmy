import * as React from 'react';
import { ClipboardPasteIcon } from 'lucide-react';
import { SERVICE_ENV_KEY, type DotenvParseOptions } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Switch,
  Textarea,
} from '@swarmy/ui';
import { EnvDiffTable } from './env-diff-table';
import { useEnvPaste } from './use-env-paste';

/** swarmy services only accept UPPER_SNAKE_CASE keys (`EnvVar`). */
export const SERVICE_ENV_PARSE: DotenvParseOptions = { keyPattern: SERVICE_ENV_KEY, keyRule: 'UPPER_SNAKE_CASE' };

interface EnvPasteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: Record<string, string>;
  /** Receives the full next env (current ⊕ paste). Called once. */
  onApply: (next: Record<string, string>) => void;
  applyLabel?: string;
  pending?: boolean;
  parseOptions?: DotenvParseOptions;
}

/** Paste a whole `.env` → located warnings → added/changed/removed preview → apply once. */
export function EnvPasteDialog(props: EnvPasteDialogProps): React.JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && <EnvPasteBody {...props} />}
    </Dialog>
  );
}

function EnvPasteBody({ onOpenChange, current, onApply, applyLabel = 'Apply', pending, parseOptions }: EnvPasteDialogProps): React.JSX.Element {
  const st = useEnvPaste(current, parseOptions);
  const { added, changed, removed } = st.diff.counts;
  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Paste .env</DialogTitle>
        <DialogDescription>
          Comments, quotes, multi-line values and <span className="mono-data">export</span> are fine. Values that
          look like secrets are masked here.
        </DialogDescription>
      </DialogHeader>
      <Textarea
        autoFocus
        rows={8}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={'DATABASE_URL=postgres://…\nexport API_KEY="…"'}
        value={st.text}
        onChange={(e) => st.setText(e.target.value)}
      />
      {st.warnings.length > 0 && (
        <ul className="text-status-warning grid gap-0.5 text-xs">
          {st.warnings.map((w, i) => (
            <li key={i}>Line {w.line}: {w.message}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          <span className="text-status-online">+{added}</span> · <span className="text-status-warning">~{changed}</span> ·{' '}
          <span className="text-status-offline">−{removed}</span>
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor="env-replace" className="text-xs">Remove keys not in the paste</Label>
          <Switch id="env-replace" checked={st.mode === 'replace'} onCheckedChange={(v) => st.setMode(v ? 'replace' : 'merge')} />
        </div>
      </div>
      <EnvDiffTable rows={st.diff.rows} masked={st.masked} onToggleMask={st.toggleMask} />
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={!st.changed || pending} onClick={() => onApply(st.diff.next)}>
          <ClipboardPasteIcon className="size-4" /> {applyLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
