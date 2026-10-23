import * as React from 'react';
import { GitFoundPanel } from './git-found-panel';
import { GitWizard } from './git-wizard';
import { useGitLink } from './use-git-link';
import { useGitWizard } from './use-git-wizard';
import { useLinkedApps } from './use-linked-apps';

interface GitNewAppCardProps {
  initialConnectionId?: string;
  onClose: () => void;
}

/**
 * "New app from Git" on CI & registry: the same wizard as Deploy → Git repo,
 * with what we found under it instead of in an aside.
 */
export function GitNewAppCard({ initialConnectionId, onClose }: GitNewAppCardProps): React.JSX.Element {
  const w = useGitWizard(initialConnectionId);
  const l = useGitLink();
  const apps = useLinkedApps();
  return (
    <div className="mb-6 flex flex-col gap-4">
      <GitWizard w={w} l={l} apps={apps} onClose={onClose} />
      <GitFoundPanel w={w} l={l} appAt={apps.at} />
    </div>
  );
}
