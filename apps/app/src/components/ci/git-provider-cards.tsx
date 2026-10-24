import * as React from 'react';
import { GitBranchIcon, GithubIcon, GitlabIcon, LinkIcon, ServerIcon, type LucideIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { GitChip } from './git-chip';
import { GIT_PROVIDERS, providerChip, type GitProviderId } from './git-providers';
import type { GitConnection } from './git-types';

const ICON: Record<GitProviderId, LucideIcon> = {
  github: GithubIcon,
  gitlab: GitlabIcon,
  gitea: GitBranchIcon,
  self: ServerIcon,
  url: LinkIcon,
};

/** Where the code lives: one card per provider, each saying whether it's connected (board 23). */
export function GitProviderCards({
  value,
  conns,
  onPick,
}: {
  value: GitProviderId;
  conns: GitConnection[];
  onPick: (p: GitProviderId) => void;
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label="Git provider" className="grid grid-cols-1 gap-2.5 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-5">
      {GIT_PROVIDERS.map((p) => {
        const Icon = ICON[p.id];
        const chip = providerChip(p.id, conns);
        const on = value === p.id;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(p.id)}
            className={cn(
              'calm-card flex min-h-11 min-w-0 flex-col items-start gap-2 px-3.5 py-3 text-left outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-ring/60',
              on && 'border-primary ring-primary/30 ring-2',
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="bg-muted text-foreground/80 flex size-8 shrink-0 items-center justify-center rounded-[9px]">
                <Icon aria-hidden className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[14px] leading-tight font-semibold">{p.name}</span>
                <span className="text-muted-foreground truncate font-mono text-[11px]">{p.host}</span>
              </span>
            </span>
            <span className="text-muted-foreground text-[12.5px] leading-snug">{p.what}</span>
            <GitChip tone={chip.tone} className="mt-auto">
              {chip.label}
            </GitChip>
          </button>
        );
      })}
    </div>
  );
}
