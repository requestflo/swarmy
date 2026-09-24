import * as React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@swarmy/ui';
import { GitConnectGithub } from './git-connect-github';
import { GitConnectGitlab } from './git-connect-gitlab';
import { GitConnectGeneric } from './git-connect-generic';

interface GitConnectPanelProps {
  onConnected: () => void;
}

/** "Connect a git provider": GitHub one-click, GitLab OAuth/token, or any git host. */
export function GitConnectPanel({ onConnected }: GitConnectPanelProps): React.JSX.Element {
  return (
    <div className="border-b px-6 py-5">
      <Tabs defaultValue="github">
        <TabsList>
          <TabsTrigger value="github">GitHub</TabsTrigger>
          <TabsTrigger value="gitlab">GitLab</TabsTrigger>
          <TabsTrigger value="generic">Any git URL</TabsTrigger>
        </TabsList>
        <TabsContent value="github" className="pt-3">
          <GitConnectGithub />
        </TabsContent>
        <TabsContent value="gitlab" className="pt-3">
          <GitConnectGitlab onConnected={onConnected} />
        </TabsContent>
        <TabsContent value="generic" className="pt-3">
          <GitConnectGeneric onConnected={onConnected} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
