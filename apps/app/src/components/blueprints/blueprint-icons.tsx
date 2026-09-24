import * as React from 'react';
import {
  ActivityIcon,
  BarChart3Icon,
  BotIcon,
  BriefcaseIcon,
  CodeIcon,
  FolderOpenIcon,
  FilmIcon,
  MessagesSquareIcon,
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
import type { BlueprintCategory, BlueprintId } from '@swarmy/core';

type Icon = React.ComponentType<{ className?: string }>;

const ICONS: Record<string, Icon> = {
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

/** Category glyphs for catalogue apps (their logo slug is `meta.icon`). */
const CATEGORY_ICONS: Partial<Record<BlueprintCategory, Icon>> = {
  cms: NewspaperIcon,
  analytics: BarChart3Icon,
  automation: WorkflowIcon,
  devtools: CodeIcon,
  data: DatabaseZapIcon,
  monitoring: ActivityIcon,
  comms: MessagesSquareIcon,
  productivity: FolderOpenIcon,
  ai: BotIcon,
  media: FilmIcon,
  business: BriefcaseIcon,
};

/** The gallery icon for a blueprint id, else its category, else a generic glyph. */
export function BlueprintIcon({
  id,
  category,
  className,
}: {
  id: BlueprintId;
  category?: BlueprintCategory;
  className?: string;
}): React.JSX.Element {
  const Icon = ICONS[id] ?? (category ? CATEGORY_ICONS[category] : undefined) ?? LayoutTemplateIcon;
  return <Icon className={className} />;
}
