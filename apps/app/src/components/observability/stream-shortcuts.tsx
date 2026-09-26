import * as React from 'react';

const KEYS: Array<[string[], string]> = [
  [['j', 'k'], 'move between lines'],
  [['enter'], 'open the line and its trace'],
  [['e'], 'next error'],
  [['/'], 'search'],
  [['space'], 'pause or resume'],
  [['esc'], 'close the line'],
];

/** The keyboard hint, shown from Controls. */
export function StreamShortcuts(): React.JSX.Element {
  return (
    <section aria-label="Keyboard shortcuts" className="calm-card flex flex-col gap-1.5 px-5 py-4">
      <h2 className="font-display text-[16.5px] font-bold tracking-[-0.01em]">Keys</h2>
      <ul className="flex flex-col gap-1.5">
        {KEYS.map(([keys, what]) => (
          <li key={what} className="text-muted-foreground flex items-center gap-2 font-mono text-[12px]">
            {keys.map((k) => (
              <kbd key={k} className="border-border text-foreground rounded border px-1.5 py-0.5 text-[11px]">{k}</kbd>
            ))}
            <span>{what}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
