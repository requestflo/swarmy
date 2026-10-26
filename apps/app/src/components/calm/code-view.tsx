import * as React from 'react';
import { CopyButton, cn } from '@swarmy/ui';
import { Depth } from './depth';

export interface CodeTab {
  /** "swarmy.yaml" · "CLI" · "REST" · "compose" · "policy JSON" … */
  label: string;
  code: string;
}

export type CodeSource = 'yaml' | 'dashboard' | 'readonly';

const SOURCE_NOTE: Record<CodeSource, string> = {
  yaml: 'Lives in swarmy.yaml. Saving opens a pull request, or keep it as a dashboard override.',
  dashboard: 'A dashboard setting. The same call works over REST, the CLI and Terraform.',
  readonly: 'Read-only: this is what swarmy sees right now.',
};

/**
 * The Code depth: the exact text form of what is on screen. Renders only at
 * Code depth (pass `always` to show it regardless, e.g. inside a code tab).
 */
export function CodeView({
  title = 'This page as code',
  tabs,
  source = 'dashboard',
  note,
  toolbar,
  always,
  className,
}: {
  title?: string;
  tabs: CodeTab[];
  source?: CodeSource;
  /** Overrides the default source note. */
  note?: React.ReactNode;
  /** Pickers that change what the code shows (e.g. which edge's file), under the title. */
  toolbar?: React.ReactNode;
  always?: boolean;
  className?: string;
}): React.JSX.Element {
  const [i, setI] = React.useState(0);
  const tab = tabs[Math.min(i, tabs.length - 1)];
  const panel = (
    <section aria-label={title} className={cn('calm-card flex min-w-0 flex-col gap-3 px-4 py-4', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-[16.5px] font-bold tracking-[-0.01em]">{title}</h2>
        <span className="text-muted-foreground text-xs">same data, same numbers</span>
        {tab ? <CopyButton value={tab.code} className="ml-auto size-8" /> : null}
      </div>
      {toolbar}
      {tabs.length > 1 ? (
        <div role="tablist" aria-label="Format" className="border-border bg-background inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-[10px] border p-0.5">
          {tabs.map((t, k) => (
            // On touch the button is a 44px hit area (8px past the strip above and
            // below, margins cancel it out); the 28px pill inside keeps the look.
            <button
              key={t.label}
              type="button"
              role="tab"
              aria-selected={k === i}
              onClick={() => setI(k)}
              className="group flex items-center outline-none pointer-coarse:-my-2 pointer-coarse:h-11"
            >
              <span
                className={cn(
                  'flex h-7 w-full items-center justify-center rounded-[8px] px-2.5 font-mono text-[11.5px] font-semibold group-focus-visible:ring-2 group-focus-visible:ring-ring/60',
                  k === i ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground group-hover:text-foreground',
                )}
              >
                {t.label}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {tab ? (
        <pre tabIndex={0} aria-label={`${tab.label} code`} className="calm-code max-h-[560px] overflow-auto px-4 py-3 whitespace-pre">
          {tab.code}
        </pre>
      ) : null}
      <p className="text-muted-foreground text-xs leading-relaxed">{note ?? SOURCE_NOTE[source]}</p>
    </section>
  );
  return always ? panel : <Depth at="code">{panel}</Depth>;
}
