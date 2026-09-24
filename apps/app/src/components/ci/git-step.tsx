import * as React from 'react';

interface GitStepProps {
  n: number;
  title: string;
  children: React.ReactNode;
}

/** One numbered step of the New-app-from-Git wizard. */
export function GitStep({ n, title, children }: GitStepProps): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">
        <span className="text-muted-foreground mono-label mr-2">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}
