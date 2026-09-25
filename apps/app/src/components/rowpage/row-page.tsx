import * as React from 'react';
import { Switch, cn } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';

/**
 * A page inside a nav row (Activity, Settings): the calm section header (top
 * bar, sentence headline, the row's tabs), then a main column and an optional
 * 400px aside. At Code depth pages put their `CodeView` at the top of the
 * aside, so nothing in the main column moves.
 */
export function RowPage({
  title,
  description,
  actions,
  eyebrow,
  aside,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-28 lg:pb-20 xl:px-10">
      <SectionHeader title={title} description={description} actions={actions} eyebrow={eyebrow} />
      <div className={cn('grid gap-6', aside ? 'xl:grid-cols-[minmax(0,1fr)_400px]' : 'grid-cols-1', className)}>
        <div className="flex min-w-0 flex-col gap-5">{children}</div>
        {aside ? <aside className="flex min-w-0 flex-col gap-4">{aside}</aside> : null}
      </div>
    </div>
  );
}

/** A quiet "number · word" line used in ledes and eyebrows. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** An on/off switch that reads as "on", not as the page's coral action. */
export function QuietSwitch({ className, ...props }: React.ComponentProps<typeof Switch>): React.JSX.Element {
  return <Switch className={cn('data-[state=checked]:bg-tone-ok pointer-coarse:my-3', className)} {...props} />;
}
