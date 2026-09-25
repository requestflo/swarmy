import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { Section } from './section';

export interface AlreadyOnItem {
  /** Bold lead word ("Backups"). */
  what: string;
  /** The plain fact ("14 of 14 at 03:00"). */
  detail: React.ReactNode;
  /** Where to *change* it. */
  to?: string;
}

/** "Already on": the things that ship enabled, one line each, each a link to change it. */
export function AlreadyOn({
  items,
  title = 'Already on',
  bare,
}: {
  items: AlreadyOnItem[];
  title?: string;
  /** Render just the lines (inside another section). */
  bare?: boolean;
}): React.JSX.Element {
  const lines = (
    <ul className="flex flex-col gap-2">
      {items.map((it) => {
        const inner = (
          <>
            <CheckIcon aria-hidden className="text-tone-ok size-3.5 shrink-0" />
            <span>
              <b className="text-foreground font-semibold">{it.what}</b> · {it.detail}
            </span>
          </>
        );
        return (
          <li key={it.what}>
            {it.to ? (
              <Link to={it.to} className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-[13px]">
                {inner}
              </Link>
            ) : (
              <span className="text-muted-foreground flex items-center gap-2 text-[13px]">{inner}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
  if (bare) return lines;
  return <Section title={title}>{lines}</Section>;
}
