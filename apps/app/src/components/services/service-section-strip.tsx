import * as React from 'react';
import {
  BoxesIcon,
  BracesIcon,
  GaugeIcon,
  GlobeIcon,
  RocketIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { cn } from '@swarmy/ui';

/** The service page's jobs-to-be-done sections — each deep-linkable via `?tab=`. */
export const SERVICE_TABS = [
  { id: 'inside', label: 'Inside', icon: BoxesIcon },
  { id: 'traffic', label: 'Traffic', icon: GlobeIcon },
  { id: 'scale', label: 'Scale', icon: GaugeIcon },
  { id: 'ship', label: 'Ship', icon: RocketIcon },
  { id: 'config', label: 'Config', icon: BracesIcon },
  { id: 'danger', label: 'Danger', icon: TriangleAlertIcon },
] as const;

export type ServiceTab = (typeof SERVICE_TABS)[number]['id'];

export function isServiceTab(value: unknown): value is ServiceTab {
  return SERVICE_TABS.some((t) => t.id === value);
}

const BASE =
  'flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors';

interface ServiceSectionStripProps {
  tab: ServiceTab;
  onTabChange: (tab: ServiceTab) => void;
}

/**
 * Pill section strip for the service page — same navy-ink pill language as the
 * stack workspace tabs, but driven by a search param so the page stays one route.
 */
export function ServiceSectionStrip({ tab, onTabChange }: ServiceSectionStripProps): React.JSX.Element {
  return (
    <nav className="scrollbar-none -mx-1 mt-8 flex gap-1 overflow-x-auto border-b pb-3 pl-1">
      {SERVICE_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onTabChange(t.id)}
          className={cn(
            BASE,
            t.id === tab
              ? 'bg-ink text-ink-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent',
          )}
        >
          <t.icon className="size-4" />
          {t.label}
        </button>
      ))}
    </nav>
  );
}
