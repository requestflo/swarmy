import * as React from 'react';
import { Button } from '@swarmy/ui';
import { GitBranchField } from './git-branch-field';
import { GitConfigPathField } from './git-config-path-field';
import { GitRepoPicker } from './git-repo-picker';
import { GitSourcePicker, type GitSource } from './git-source-picker';
import { GitStep } from './git-step';
import { GitUrlFields } from './git-url-fields';
import {
  canListRepos,
  type GitConnection,
  type LinkRepoRequest,
  type ProviderRepo,
} from './git-types';

interface GitNewAppFormProps {
  connections: GitConnection[];
  initialConnectionId?: string;
  linking: boolean;
  onLink: (req: LinkRepoRequest) => void;
  onCancel: () => void;
}

/** Pick connection → repo → branch → (monorepo) swarmy.yaml path → Link. */
export function GitNewAppForm(props: GitNewAppFormProps): React.JSX.Element {
  const initial = props.connections.find((c) => c.id === props.initialConnectionId);
  const [source, setSource] = React.useState<GitSource | undefined>(
    initial ? { connection: initial } : undefined,
  );
  const [repo, setRepo] = React.useState<ProviderRepo | null>(null);
  const [url, setUrl] = React.useState('');
  const [branch, setBranch] = React.useState('main');
  const [configPath, setConfigPath] = React.useState('');
  const [deployKey, setDeployKey] = React.useState(false);

  const conn = source?.connection;
  const picking = conn ? canListRepos(conn.kind) : false;
  const pickSource = (s: GitSource): void => {
    setSource(s);
    setRepo(null);
    setBranch('main');
  };
  const pickRepo = (r: ProviderRepo): void => {
    setRepo(r);
    setBranch(r.defaultBranch);
  };

  const ready =
    source !== undefined &&
    (picking ? Boolean(repo) : url.trim().length > 0) &&
    branch.trim().length > 0;
  const submit = (): void =>
    props.onLink({
      connectionId: conn?.id,
      ...(picking && repo
        ? { repo: { id: repo.id, fullName: repo.fullName, cloneUrl: repo.cloneUrl } }
        : { url: url.trim() }),
      branch: branch.trim(),
      configPath: configPath.trim() || undefined,
      deployKey: !picking && deployKey ? true : undefined,
    });

  return (
    <div className="space-y-6">
      <GitStep n={1} title="Where’s the code?">
        <GitSourcePicker connections={props.connections} value={source} onChange={pickSource} />
      </GitStep>
      {source === undefined ? null : picking && conn ? (
        <>
          <GitStep n={2} title="Pick a repo">
            <GitRepoPicker connectionId={conn.id} value={repo} onChange={pickRepo} />
          </GitStep>
          {repo ? (
            <GitStep n={3} title="Deploy from branch">
              <GitBranchField conn={conn} repo={repo} value={branch} onChange={setBranch} />
            </GitStep>
          ) : null}
        </>
      ) : (
        <GitStep n={2} title="Repo and branch">
          <GitUrlFields
            url={url}
            onUrlChange={setUrl}
            branch={branch}
            onBranchChange={setBranch}
            deployKey={deployKey}
            onDeployKeyChange={setDeployKey}
          />
        </GitStep>
      )}
      {ready ? (
        <GitStep n={picking ? 4 : 3} title="Which swarmy.yaml?">
          <GitConfigPathField
            source={{
              connectionId: conn?.id,
              cloneUrl: picking && repo ? repo.cloneUrl : url.trim(),
              ref: branch.trim(),
            }}
            value={configPath}
            onChange={setConfigPath}
          />
        </GitStep>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!ready || props.linking}>
          {props.linking ? 'Linking…' : 'Link repo'}
        </Button>
      </div>
    </div>
  );
}
