import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, StatusBadge, cn, type StatusTone } from '@swarmy/ui';
import type { ImageScanView } from '@swarmy/core';
import { ScanDetailInline } from './scan-detail-inline';

function scanTone(scan: ImageScanView): StatusTone {
  if (scan.status === 'error') return 'offline';
  if (scan.criticalCount > 0) return 'offline';
  if (scan.highCount > 0) return 'warning';
  return 'online';
}

function scanLabel(scan: ImageScanView): string {
  if (scan.status === 'error') return 'error';
  if (scan.criticalCount > 0) return 'critical';
  if (scan.highCount > 0) return 'attention';
  return 'clean';
}

function imageName(ref: string): string {
  const noDigest = ref.split('@')[0] ?? ref;
  const slash = noDigest.indexOf('/');
  return slash >= 0 ? noDigest.slice(slash + 1) : noDigest;
}

interface ScanRowProps {
  scan: ImageScanView;
  expanded: boolean;
  onToggle: () => void;
}

/** One scan row; expand for CVE detail + rescan action inline, no drawer. */
export function ScanRow({ scan: s, expanded, onToggle }: ScanRowProps): React.JSX.Element {
  return (
    <div className={cn(expanded && 'bg-accent/40 shadow-[inset_3px_0_0_var(--primary)]')}>
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-accent/60 grid w-full grid-cols-[1fr_auto] items-center gap-x-4 px-6 py-4 text-left transition-colors sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
      >
        <div className="min-w-0">
          <p className="mono-data truncate font-medium">{imageName(s.imageRef)}</p>
          <p className="text-muted-foreground mono-label truncate sm:hidden">
            {s.criticalCount} crit · {s.highCount} high
          </p>
        </div>
        <span className="mono-data text-muted-foreground hidden truncate sm:block">
          {s.digest ? s.digest.replace('sha256:', '').slice(0, 12) : '—'}
        </span>
        <span className="mono-data hidden sm:block">
          <span className={s.criticalCount > 0 ? 'text-status-offline font-semibold' : ''}>
            {s.criticalCount}
          </span>
          {' / '}
          <span className={s.highCount > 0 ? 'text-status-warning' : ''}>{s.highCount}</span>
          {' / '}
          {s.mediumCount}
        </span>
        <span className="text-muted-foreground mono-label hidden truncate sm:block">
          {new Date(s.scannedAt).toLocaleString()}
        </span>
        <div className="flex items-center justify-end gap-2">
          <StatusBadge tone={scanTone(s)} label={scanLabel(s)} />
          <ChevronDownIcon className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
        </div>
      </button>
      <Collapsible open={expanded}>
        <CollapsibleContent>
          <div className="grid gap-4 px-6 pb-6">{expanded ? <ScanDetailInline scanId={s.id} /> : null}</div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
