import { cn } from '../lib/utils';

export type StatusTone = 'online' | 'warning' | 'offline' | 'neutral' | 'progress';

const TONE: Record<StatusTone, { dot: string; text: string }> = {
  online: { dot: 'bg-emerald-500', text: 'text-emerald-500' },
  warning: { dot: 'bg-amber-500', text: 'text-amber-500' },
  offline: { dot: 'bg-red-500', text: 'text-red-500' },
  progress: { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-500' },
  neutral: { dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
};

export function StatusBadge({
  tone,
  label,
  className,
}: {
  tone: StatusTone;
  label: string;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', t.text, className)}>
      <span className={cn('size-2 rounded-full', t.dot)} />
      {label}
    </span>
  );
}
