import * as React from 'react';
import { useLocation } from '@tanstack/react-router';
import { SECTIONS, NAV_GROUPS, PRIMARY, groupForPathname, type DestinationGroup } from '@/lib/destinations';
import { useNavBadges } from '@/lib/use-nav-badges';
import { CalmTabs, CalmTopBar, SayHeader, type Crumb } from '@/components/calm';

/**
 * The header for every page inside a nav row (Network, Data, Activity,
 * Settings, the Deploy flow). Calm Layers anatomy: the top bar (mono
 * breadcrumb + this page's depth switch), the sentence headline, one action,
 * then the row's pages as tabs. The row comes from the pathname; the old
 * `section` prop is accepted for compatibility and ignored.
 *
 * It renders full-bleed (the top bar spans the content area), so pages put it
 * first, outside their padded container — `SectionHeader` pulls itself out of
 * a `px-6 xl:px-10` container with negative margins when it's inside one.
 */
export function SectionHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  /** @deprecated the row is derived from the pathname. */
  section?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
}): React.JSX.Element {
  const { pathname } = useLocation();
  const group = groupForPathname(pathname);
  const badges = useNavBadges();
  // The Deploy flow's source cards are its chooser; it has no tab strip.
  const tabs = group && group !== 'Deploy'
    ? SECTIONS.filter((s) => s.group === group).map((s) => ({
        to: s.to,
        label: s.label,
        exact: s.exact,
        count: s.badge ? badges[s.badge] : 0,
      }))
    : [];
  const crumbs = crumbsFor(group, pathname);
  return (
    <div className="-mx-6 -mt-8 mb-7 xl:-mx-10">
      <CalmTopBar crumbs={crumbs} />
      <div className="flex flex-col gap-5 px-6 pt-7 xl:px-10">
        <SayHeader eyebrow={eyebrow} title={title} lede={description} actions={actions} />
        {tabs.length > 1 ? <CalmTabs tabs={tabs} label={`${rowLabel(group)} pages`} /> : null}
      </div>
    </div>
  );
}

function rowLabel(group: DestinationGroup | null): string {
  if (group === 'Deploy') return 'Deploy an app';
  return NAV_GROUPS.find((g) => g.group === group)?.label ?? 'swarmy';
}

/** Row / page crumbs from the destinations table. */
export function crumbsFor(group: DestinationGroup | null, pathname: string): Crumb[] {
  const row = group === 'Deploy' ? { to: '/deploy', label: 'Deploy an app' } : PRIMARY.find((p) => p.group === group);
  const page = SECTIONS.filter((s) => s.group === group && (s.exact ? pathname === s.to : pathname === s.to || pathname.startsWith(`${s.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];
  const out: Crumb[] = [];
  if (row) out.push({ label: row.label, to: page && page.to !== row.to ? row.to : undefined });
  if (page && (!row || page.to !== row.to)) out.push({ label: page.label });
  return out.length ? out : [{ label: 'swarmy' }];
}
