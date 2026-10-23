import * as React from 'react';
import { Button } from '@swarmy/ui';
import type { ConfirmKind } from './connect-flow';

/** The one confirm before the change: both apps' services restart once, rolling. */
export function ConfirmLink({
  kind,
  app,
  peer,
  total,
  busy,
  onYes,
  onNo,
}: {
  kind: ConfirmKind;
  app: string;
  peer: string;
  /** Services of both apps, once both are known. */
  total: number | null;
  busy: boolean;
  onYes: () => void;
  onNo: () => void;
}): React.JSX.Element {
  const yes = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => yes.current?.focus(), [kind, peer]);
  const off = kind === 'disconnect';
  const who = total === null ? 'Services' : `${total} service${total === 1 ? '' : 's'}`;
  return (
    <section aria-label="Confirm" className="border-border bg-background flex flex-col gap-2 rounded-xl border px-3.5 py-3">
      <b className="text-[13.5px] font-semibold">{off ? `Disconnect ${app} and ${peer}?` : `Connect ${app} and ${peer}?`}</b>
      <span className="text-muted-foreground text-[12.5px] leading-relaxed">
        {who} of both apps restart once, rolling.
        {off ? ` After that, ${peer} can’t reach ${app}’s services and ${app} can’t reach ${peer}’s.` : ''}
      </span>
      <div className="flex flex-wrap gap-2">
        <Button ref={yes} size="sm" disabled={busy} onClick={onYes} className="pointer-coarse:min-h-11">
          {busy ? (off ? 'Disconnecting…' : 'Connecting…') : off ? 'Disconnect and restart' : 'Connect and restart'}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onNo} className="pointer-coarse:min-h-11">
          Cancel
        </Button>
      </div>
    </section>
  );
}
