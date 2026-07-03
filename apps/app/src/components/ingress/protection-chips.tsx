import * as React from 'react';
import { ShieldCheckIcon } from 'lucide-react';
import { Badge } from '@swarmy/ui';
import { summarizeProtection, type RouteProtection } from './protection-model';

interface ProtectionChipsProps {
  protection: RouteProtection | null | undefined;
}

/** Compact protection summary chips for a route row ("100 req/min · 3 IP rules"). */
export function ProtectionChips({ protection }: ProtectionChipsProps): React.JSX.Element | null {
  const chips = summarizeProtection(protection);
  if (chips.length === 0) return null;
  return (
    <span className="hidden flex-wrap items-center gap-1.5 lg:flex">
      <ShieldCheckIcon className="text-status-online size-3.5" />
      {chips.map((c) => (
        <Badge key={c} variant="muted" className="mono-data text-[0.65rem]">
          {c}
        </Badge>
      ))}
    </span>
  );
}
