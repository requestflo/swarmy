import * as React from 'react';
import { Input } from '@swarmy/ui';
import { GitBranchPicker } from './git-branch-picker';
import { branchRepoKey, canListBranches, type GitConnection, type ProviderRepo } from './git-types';

interface GitBranchFieldProps {
  conn: GitConnection;
  repo: ProviderRepo;
  value: string;
  onChange: (branch: string) => void;
}

/** The provider's branch list where it has one (GitHub, GitLab); a typed name otherwise. */
export function GitBranchField({
  conn,
  repo,
  value,
  onChange,
}: GitBranchFieldProps): React.JSX.Element {
  if (canListBranches(conn.kind)) {
    return (
      <GitBranchPicker
        connectionId={conn.id}
        repoKey={branchRepoKey(conn.kind, repo)}
        value={value}
        onChange={onChange}
      />
    );
  }
  return <Input value={value} onChange={(e) => onChange(e.target.value)} className="mono-data" />;
}
