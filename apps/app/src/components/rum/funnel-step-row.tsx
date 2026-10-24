import * as React from 'react';
import { ArrowDownIcon, ArrowUpIcon, XIcon } from 'lucide-react';
import { Input, cn } from '@swarmy/ui';
import { EVENT_RE, PATH_RE, type FunnelDraftStep } from './funnel-model';

interface FunnelStepRowProps {
  step: FunnelDraftStep;
  index: number;
  count: number;
  disabled: boolean;
  onChange: (step: FunnelDraftStep) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

const iconBtn =
  'hover:bg-accent text-muted-foreground inline-flex size-8 items-center justify-center rounded-md disabled:opacity-30 pointer-coarse:size-11';

/** One step: its path pattern (`*` matches anything), an optional custom event, a name, and its place. */
export function FunnelStepRow({ step, index, count, disabled, onChange, onMove, onRemove }: FunnelStepRowProps): React.JSX.Element {
  const badPath = !PATH_RE.test(step.path);
  const badEvent = Boolean(step.event) && !EVENT_RE.test(step.event ?? '');
  const n = index + 1;
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground w-5 text-right font-mono text-xs">{n}</span>
      <Input
        value={step.path}
        onChange={(e) => onChange({ ...step, path: e.target.value })}
        placeholder="/checkout/*"
        disabled={disabled}
        aria-label={`Step ${n} page path`}
        aria-invalid={badPath}
        className={cn('h-8 min-w-0 flex-[2_1_10rem] font-mono text-xs', badPath && 'border-status-offline')}
      />
      <Input
        value={step.event ?? ''}
        onChange={(e) => onChange({ ...step, event: e.target.value || undefined })}
        placeholder="event (optional)"
        disabled={disabled}
        aria-label={`Step ${n} custom event`}
        aria-invalid={badEvent}
        className={cn('h-8 min-w-0 flex-[1_1_8rem] font-mono text-xs', badEvent && 'border-status-offline')}
      />
      <Input
        value={step.name ?? ''}
        onChange={(e) => onChange({ ...step, name: e.target.value || undefined })}
        placeholder="name (optional)"
        maxLength={40}
        disabled={disabled}
        aria-label={`Step ${n} name`}
        className="h-8 min-w-0 flex-[1_1_7rem] text-xs"
      />
      <span className="flex items-center">
        <button type="button" className={iconBtn} disabled={disabled || index === 0} onClick={() => onMove(-1)} aria-label={`Move step ${n} up`}>
          <ArrowUpIcon className="size-3.5" />
        </button>
        <button type="button" className={iconBtn} disabled={disabled || index === count - 1} onClick={() => onMove(1)} aria-label={`Move step ${n} down`}>
          <ArrowDownIcon className="size-3.5" />
        </button>
        <button type="button" className={iconBtn} disabled={disabled || count <= 2} onClick={onRemove} aria-label={`Remove step ${n}`}>
          <XIcon className="size-3.5" />
        </button>
      </span>
    </li>
  );
}
