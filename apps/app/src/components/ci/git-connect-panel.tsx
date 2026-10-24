import * as React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@swarmy/ui';
import { GitConnectGithub } from './git-connect-github';
import { GitConnectGitlab } from './git-connect-gitlab';
import { GitConnectGitea } from './git-connect-gitea';
import { GitConnectGeneric } from './git-connect-generic';
import type { GitProviderId } from './git-providers';
import type { GitReturn } from './git-return';

interface GitConnectPanelProps {
  onConnected: () => void;
  /** One provider card's connect step (the Deploy wizard); absent = every provider in tabs (/ci). */
  provider?: GitProviderId;
  returnTo?: GitReturn['to'];
}

/** "Connect a git provider": GitHub one-click, GitLab or Gitea/Forgejo OAuth/token, or any git host. */
export function GitConnectPanel({ onConnected, provider, returnTo }: GitConnectPanelProps): React.JSX.Element {
  if (provider === 'github') return <GitConnectGithub host="github" returnTo={returnTo} />;
  if (provider === 'gitlab') return <GitConnectGitlab onConnected={onConnected} returnTo={returnTo} />;
  if (provider === 'gitea') return <GitConnectGitea onConnected={onConnected} returnTo={returnTo} />;
  if (provider === 'url') return <GitConnectGeneric onConnected={onConnected} />;
  if (provider === 'self') {
    return (
      <Tabs defaultValue="ghes">
        <TabsList>
          <TabsTrigger value="ghes">GitHub Enterprise</TabsTrigger>
          <TabsTrigger value="gitlab">GitLab self-managed</TabsTrigger>
        </TabsList>
        <TabsContent value="ghes" className="pt-3">
          <GitConnectGithub host="self" returnTo={returnTo} />
        </TabsContent>
        <TabsContent value="gitlab" className="pt-3">
          <GitConnectGitlab onConnected={onConnected} returnTo={returnTo} />
        </TabsContent>
      </Tabs>
    );
  }
  return (
    <div className="border-b px-6 py-5">
      <Tabs defaultValue="github">
        <TabsList>
          <TabsTrigger value="github">GitHub</TabsTrigger>
          <TabsTrigger value="gitlab">GitLab</TabsTrigger>
          <TabsTrigger value="gitea">Gitea / Forgejo</TabsTrigger>
          <TabsTrigger value="generic">Any git URL</TabsTrigger>
        </TabsList>
        <TabsContent value="github" className="pt-3">
          <GitConnectGithub />
        </TabsContent>
        <TabsContent value="gitlab" className="pt-3">
          <GitConnectGitlab onConnected={onConnected} />
        </TabsContent>
        <TabsContent value="gitea" className="pt-3">
          <GitConnectGitea onConnected={onConnected} />
        </TabsContent>
        <TabsContent value="generic" className="pt-3">
          <GitConnectGeneric onConnected={onConnected} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
