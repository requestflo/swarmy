import * as React from 'react';

export interface SideSection {
  id: string;
  label: string;
}

/** The Settings board's side-sections layout: a quiet anchor list beside the sections. */
export function SettingsSections({ sections, children }: { sections: SideSection[]; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
      <nav aria-label="On this page" className="hidden lg:block">
        <ul className="sticky top-6 flex flex-col gap-0.5">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] block rounded-lg px-3 py-2 text-[13.5px] font-semibold">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </div>
  );
}
