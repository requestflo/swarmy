import * as React from 'react';
import { Tech } from '@/components/calm';
import { SOURCE_CARDS } from './deploy-choice';

/** The hub aside while the git flow is open: what connecting a repo does (the wizard is in the main column). */
export function DeployGitAside(): React.JSX.Element {
  const git = SOURCE_CARDS.find((c) => c.key === 'git')!;
  return (
    <section aria-label="Git repo" className="calm-card flex flex-col gap-3 px-5 py-5">
      <h2 className="font-display text-[1.35rem] font-bold tracking-[-0.02em]">From a git repo</h2>
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">
        Connect GitHub, GitLab or any git host. swarmy builds each push on your servers and ships it, with previews for pull requests.
      </p>
      <Tech>{git.tech}</Tech>
    </section>
  );
}
