import { FileCodeIcon, GitBranchIcon, LayoutGridIcon, PackageIcon, type LucideIcon } from 'lucide-react';

/** What the Deploy hub has open: the template shelf, or the git flow. Compose and image are their own pages. */
export type DeploySource = 'template' | 'git';

export interface SourceCard {
  key: DeploySource | 'compose' | 'image';
  title: string;
  /** Plain line under the title. */
  say: string;
  /** What swarmy makes of it (Controls). */
  tech: string;
  icon: LucideIcon;
  /** Compose and image go to their own pages. */
  to?: '/stacks/new' | '/services/new';
}

export const SOURCE_CARDS: SourceCard[] = [
  { key: 'template', title: 'Template', say: 'Ready-made', tech: 'a pinned swarmy.yaml · data and secrets wired', icon: LayoutGridIcon },
  { key: 'compose', title: 'Compose file', say: 'Paste or drop YAML', tech: 'docker compose → one app · .env substitution', icon: FileCodeIcon, to: '/stacks/new' },
  { key: 'image', title: 'Image', say: 'ghcr.io/you/app:tag', tech: 'one image → one service', icon: PackageIcon, to: '/services/new' },
  { key: 'git', title: 'Git repo', say: 'We build it, every push', tech: 'swarmy.yaml, compose or Dockerfile · built on your servers', icon: GitBranchIcon },
];

/** "60+" — the catalogue size, rounded down so it stays true as it grows. */
export function roundedCount(n: number): string {
  return n >= 10 ? `${Math.floor(n / 10) * 10}+` : String(n);
}
