import * as React from 'react';
import { Input, Label } from '@swarmy/ui';
import { QuietSwitch } from '@/components/rowpage/row-page';

interface GitUrlFieldsProps {
  url: string;
  onUrlChange: (url: string) => void;
  branch: string;
  onBranchChange: (branch: string) => void;
  deployKey: boolean;
  onDeployKeyChange: (on: boolean) => void;
}

const isSsh = (u: string): boolean => /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(u.trim());

/** Typed-URL source: clone URL, branch, and (for SSH remotes) a swarmy-minted deploy key. */
export function GitUrlFields(props: GitUrlFieldsProps): React.JSX.Element {
  const ssh = isSsh(props.url);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div className="grid gap-1.5">
          <Label className="mono-label">Repository URL</Label>
          <Input
            value={props.url}
            onChange={(e) => props.onUrlChange(e.target.value)}
            placeholder="https://git.example.com/team/app.git or git@host:team/app.git"
            className="mono-data"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Branch</Label>
          <Input
            value={props.branch}
            onChange={(e) => props.onBranchChange(e.target.value)}
            className="mono-data"
          />
        </div>
      </div>
      <div className="bg-accent/40 flex items-center justify-between gap-4 rounded-xl px-4 py-3">
        <div>
          <Label className="font-medium">Make a deploy key</Label>
          <p className="text-muted-foreground text-xs">
            {ssh
              ? 'SSH remotes always get one.'
              : 'For private repos over SSH. You paste the public half into your git host.'}
          </p>
        </div>
        <QuietSwitch
          checked={ssh || props.deployKey}
          disabled={ssh}
          onCheckedChange={props.onDeployKeyChange}
        />
      </div>
    </div>
  );
}
