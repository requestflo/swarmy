import * as React from 'react';

/**
 * Hot Signal page header: eyebrow wayfinding pill + bold display headline.
 * `title` may contain <em> for coral emphasis (pass a ReactNode).
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="headline mt-3 text-[2.2rem] sm:text-5xl">{title}</h1>
        {description ? (
          <p className="text-muted-foreground mt-2 max-w-xl text-sm sm:text-base">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
