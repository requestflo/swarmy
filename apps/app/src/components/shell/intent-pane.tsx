import * as React from 'react';
import type { Intent } from '@/lib/intents';

export interface PaneProps {
  intent: Intent;
  /** The CTA, so Enter on a "Do it" row moves focus here (a second Enter confirms). */
  ctaRef: React.RefObject<HTMLButtonElement | null>;
  onGo: (intent: Intent) => void;
  onDone: () => void;
}

/** The ⌘K preview's frame: eyebrow, what will happen, its facts, the button, and the call behind it. */
export function Pane({ eyebrow, title, body, rows, cta, foot }: {
  eyebrow: string;
  title: string;
  body: string;
  rows: Array<[string, string]>;
  cta: React.ReactNode;
  /** A real REST path or CLI line; omitted when there is none. */
  foot?: string;
}): React.JSX.Element {
  return (
    <section aria-label="Preview" aria-live="polite" className="flex h-full flex-col gap-3 p-5">
      <span className="calm-eyebrow">{eyebrow}</span>
      <h2 className="font-display text-[1.15rem] leading-snug font-bold tracking-[-0.01em]">{title}</h2>
      <p className="text-muted-foreground text-[13px] leading-relaxed">{body}</p>
      {rows.length ? (
        <dl className="border-border divide-border divide-y border-y text-[12.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-1.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-auto flex flex-col gap-2 pt-2">
        {cta}
        {foot ? <code className="text-muted-foreground block truncate font-mono text-[11px]" title={foot}>{foot}</code> : null}
      </div>
    </section>
  );
}
