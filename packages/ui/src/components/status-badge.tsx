import { cn } from '../lib/utils';

export type StatusTone = 'online' | 'warning' | 'offline' | 'neutral' | 'progress';

const TONE: Record<StatusTone, string> = {
  online: 'text-status-online',
  warning: 'text-status-warning',
  offline: 'text-status-offline',
  progress: 'text-status-progress',
  neutral: 'text-status-idle',
};

/** Status dot + label, driven by the cluster status tokens (never raw palette). */
export function StatusBadge({
  tone,
  label,
  className,
}: {
  tone: StatusTone;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', TONE[tone], className)}>
      <span
        className={cn(
          'size-2 rounded-full bg-current',
          tone === 'progress' && 'animate-pulse',
        )}
      />
      {label}
    </span>
  );
}
