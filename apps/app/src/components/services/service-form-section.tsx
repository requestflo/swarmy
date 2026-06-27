import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, cn } from '@swarmy/ui';

interface ServiceFormSectionProps {
  title: string;
  caption?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * Premium form section surface: a single `.card-pop` with an eyebrow-style mono
 * title, optional caption, and a right-aligned action. Shared by every block of
 * the deploy form so the focus surface stays visually consistent.
 */
export function ServiceFormSection({
  title,
  caption,
  action,
  children,
  className,
}: ServiceFormSectionProps): React.JSX.Element {
  return (
    <Card className={cn('card-pop border-0', className)}>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle className="mono-label">{title}</CardTitle>
          {caption ? <p className="text-muted-foreground mt-1.5 text-sm">{caption}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  );
}
