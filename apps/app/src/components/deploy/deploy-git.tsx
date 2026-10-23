import * as React from 'react';
import { CalmPage } from '@/components/calm';
import { GitFoundPanel } from '@/components/ci/git-found-panel';
import type { GitRoundTrip } from '@/components/ci/git-receipt';
import { GitWizard } from '@/components/ci/git-wizard';
import { useGitLink } from '@/components/ci/use-git-link';
import { useGitWizard } from '@/components/ci/use-git-wizard';
import { useLinkedApps } from '@/components/ci/use-linked-apps';
import { DeployCode } from './deploy-code';

/**
 * Deploy → Git repo (board 23, GitConnect): the hub's header and source
 * cards stay put; the wizard takes the main column and what we found (with
 * the one coral Link & scan) takes the aside. A provider round trip comes
 * back here with its receipt.
 */
export function DeployGit({
  top,
  trip,
  onTripDismiss,
  onBack,
}: {
  top: React.ReactNode;
  trip: GitRoundTrip | null;
  onTripDismiss: () => void;
  onBack: () => void;
}): React.JSX.Element {
  const w = useGitWizard(trip?.git === 'connected' ? trip.connection : undefined);
  const l = useGitLink();
  const apps = useLinkedApps();
  return (
    <CalmPage
      wide
      crumbs={[{ label: 'Overview', to: '/overview' }, { label: 'deploy' }, { label: 'from git' }]}
      aside={
        <>
          <DeployCode source="git" template={null} />
          <div className="xl:sticky xl:top-4">
            <GitFoundPanel w={w} l={l} appAt={apps.at} />
          </div>
        </>
      }
    >
      {top}
      <GitWizard w={w} l={l} apps={apps} trip={trip} onTripDismiss={onTripDismiss} returnTo="/deploy" onClose={onBack} />
    </CalmPage>
  );
}
