import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { SECTIONS, NAV_GROUPS, type NavGroup } from '@/lib/destinations';
import { useNavBadges } from '@/lib/use-nav-badges';

/**
 * Page header for every surface inside a nav section (Deploy / Platform /
 * Operations / Governance / Settings). Drop-in for `PageHeader`, with the
 * section supplying the eyebrow and a tab row across the section's sibling
 * surfaces — the in-page half of the flat 8-destination sidenav. The page
 * keeps its own data-driven headline; the tabs carry live attention badges
 * so a firing alert is visible from anywhere in the section.
 */
export function SectionHeader({
  section,
  title,
  description,
  actions,
}: {
  section: NavGroup['group'];
  title: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
}): React.JSX.Element {
  const label = NAV_GROUPS.find((g) => g.group === section)?.label ?? section;
  return (
    <div className="mb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <span className="eyebrow">{label}</span>
          <h1 className="headline mt-3 text-[2.2rem] sm:text-5xl">{title}</h1>
          {description ? (
            <p className="text-muted-foreground mt-2 max-w-xl text-sm sm:text-base">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <SectionTabs section={section} />
    </div>
  );
}

function SectionTabs({ section }: { section: NavGroup['group'] }): React.JSX.Element {
  const { pathname } = useLocation();
  const badges = useNavBadges();
  const tabs = SECTIONS.filter((s) => s.group === section);
  // Most-specific prefix match wins, so /settings stays quiet on /settings/api-keys.
  const activeTo = tabs
    .filter((t) => pathname === t.to || pathname.startsWith(`${t.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]?.to;
  return (
    <nav className="border-border mt-6 flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => {
        const active = t.to === activeTo;
        const count = t.badge ? badges[t.badge] : 0;
        return (
          <Link
            key={t.to}
            to={t.to}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors',
              active
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {t.label}
            {count > 0 && (
              <span className="bg-primary text-primary-foreground flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold">
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
