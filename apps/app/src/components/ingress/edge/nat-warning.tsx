import * as React from 'react';
import { Button } from '@swarmy/ui';

/**
 * A server behind NAT can't take visits: nothing reaches it from outside.
 * Board 31 offers the way that works — a Cloudflare Tunnel dials out.
 */
export function NatWarning({
  name,
  already,
  onTunnel,
  onAnyway,
  onDismiss,
}: {
  name: string;
  /** It is already marked as an edge (not just about to be). */
  already: boolean;
  onTunnel: () => void;
  onAnyway?: () => void;
  onDismiss?: () => void;
}): React.JSX.Element {
  return (
    <div role="alert" className="border-status-warning/40 bg-status-warning/[0.06] flex flex-col gap-2 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed">
      <p>
        {name} {already ? 'is marked as an edge but sits' : 'is'} behind NAT with no public address, so visitors can&apos;t reach it. Use a
        Cloudflare Tunnel instead: it dials out, so no ports need to be open.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onTunnel} className="pointer-coarse:min-h-11">
          Use a tunnel
        </Button>
        {onAnyway ? (
          <Button variant="ghost" size="sm" onClick={onAnyway} className="pointer-coarse:min-h-11">
            Make it an edge anyway
          </Button>
        ) : null}
        {onDismiss ? (
          <Button variant="ghost" size="sm" onClick={onDismiss} className="pointer-coarse:min-h-11">
            Keep it off
          </Button>
        ) : null}
      </div>
    </div>
  );
}
