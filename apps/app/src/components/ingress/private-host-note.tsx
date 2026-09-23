import * as React from 'react';
import { ShieldAlertIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { isPrivateHost } from '@/lib/private-host';

/**
 * Shown under any domain/host field when the entered name can only ever get
 * swarmy's local certificate (LAN names, private-IP sslip.io/nip.io hosts).
 * Renders nothing for public hosts, so it can sit unconditionally under the
 * input.
 */
export function PrivateHostNote({
  host,
  className,
}: {
  host: string;
  className?: string;
}): React.JSX.Element | null {
  if (!host.trim() || !isPrivateHost(host)) return null;
  return (
    <p className={cn('text-status-warning flex items-start gap-1.5 text-xs', className)}>
      <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        Private address — served with swarmy's local certificate; your browser will warn the
        first time.
      </span>
    </p>
  );
}
