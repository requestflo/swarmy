import * as React from 'react';
import {
  BoxesIcon,
  BracesIcon,
  GaugeIcon,
  GlobeIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { cn } from '@swarmy/ui';

/** The service page's jobs-to-be-done sections — each deep-linkable via `?tab=`. */
export const SERVICE_TABS = [
  { id: 'inside', label: 'Inside', icon: BoxesIcon },
  { id: 'traffic', label: 'Traffic', icon: GlobeIcon },
  { id: 'scale', label: 'Copies', icon: GaugeIcon },
  { id: 'config', label: 'Settings', icon: BracesIcon },
  { id: 'danger', label: 'Remove', icon: TriangleAlertIcon },
] as const;

export type ServiceTab = (typeof SERVICE_TABS)[number]['id'];

export function isServiceTab(value: unknown): value is ServiceTab {
  return SERVICE_TABS.some((t) => t.id === value);
}

const BASE =
  'flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

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
    <nav aria-label="Service sections" className="scrollbar-none border-border mt-8 flex gap-1 overflow-x-auto border-b">
      {SERVICE_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-current={t.id === tab ? 'page' : undefined}
          onClick={() => onTabChange(t.id)}
          className={cn(
            BASE,
            t.id === tab ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent',
          )}
        >
          <t.icon aria-hidden className="size-4" />
          {t.label}
        </button>
      ))}
    </nav>
  );
}
