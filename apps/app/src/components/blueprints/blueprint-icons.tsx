import * as React from 'react';
import {
  ActivityIcon,
  DatabaseZapIcon,
  FileCodeIcon,
  GlobeIcon,
  LayoutTemplateIcon,
  ListOrderedIcon,
  NewspaperIcon,
  SearchIcon,
  ServerIcon,
  WorkflowIcon,
} from 'lucide-react';
import type { BlueprintId } from '@swarmy/core';

const ICONS: Record<BlueprintId, React.ComponentType<{ className?: string }>> = {
  'node-api': ServerIcon,
  'nextjs-app': GlobeIcon,
  'static-site': FileCodeIcon,
  wordpress: NewspaperIcon,
  n8n: WorkflowIcon,
  directus: DatabaseZapIcon,
  'worker-with-queue': ListOrderedIcon,
  'meilisearch-app': SearchIcon,
  'monitoring-notes': ActivityIcon,
};

/** The gallery icon for a blueprint id (safe fallback for unknown ids). */
export function BlueprintIcon({
  id,
  className,
}: {
  id: BlueprintId;
  className?: string;
}): React.JSX.Element {
  const Icon = ICONS[id] ?? LayoutTemplateIcon;
  return <Icon className={className} />;
}
