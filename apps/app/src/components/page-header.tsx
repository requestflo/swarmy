import * as React from 'react';
import { useLocation } from '@tanstack/react-router';
import { groupForPathname } from '@/lib/destinations';
import { CalmTopBar, SayHeader } from '@/components/calm';
import { crumbsFor } from './section-header';

/**
 * A page header outside a tabbed row (server detail, new service, terminals).
 * Calm Layers anatomy: top bar with breadcrumb + depth switch, then the
 * sentence headline. `eyebrow` becomes the last crumb context.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  const { pathname } = useLocation();
  const crumbs = crumbsFor(groupForPathname(pathname), pathname);
  if (crumbs[crumbs.length - 1]?.label !== eyebrow) crumbs.push({ label: eyebrow });
  return (
    <div className="-mx-6 -mt-8 mb-7 xl:-mx-10">
      <CalmTopBar crumbs={crumbs} />
      <div className="px-6 pt-7 xl:px-10">
        <SayHeader title={title} lede={description} actions={actions} />
      </div>
    </div>
  );
}
