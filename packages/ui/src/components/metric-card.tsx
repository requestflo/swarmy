import * as React from 'react';
import { cn } from '../lib/utils';
import { Card, CardContent } from './card';

export function MetricCard({
  label,
  value,
  hint,
  icon,
  accent,
  children,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  accent?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('gap-0 py-0', className)}>
      <CardContent className="flex flex-col gap-2 p-5">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {label}
          </span>
          {icon ? (
            <span className={cn('text-muted-foreground', accent && 'text-primary')}>{icon}</span>
          ) : null}
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
        {children}
      </CardContent>
    </Card>
  );
}
