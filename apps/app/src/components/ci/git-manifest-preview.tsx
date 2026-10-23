import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { TextSkeleton } from '@/components/states';
import { GitChip } from './git-chip';
import { postGithubManifest } from './git-nav';
import { GITHUB_WEB, hostOf } from './git-providers';
import { rememberGitReturn, type GitReturn } from './git-return';
import { useDebouncedValue } from './use-debounced-value';
import { useGithubManifest } from './use-github-manifest';

interface GitManifestPreviewProps {
  webBase: string;
  /** The "GitHub host" row's value (an input on Self-hosted, plain text on GitHub). */
  hostField: React.ReactNode;
  /** Where the round trip comes back to (the Deploy wizard); absent = /ci. */
  returnTo?: GitReturn['to'];
}

function Row({ k, children }: { k: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-center">
      <span className="text-muted-foreground text-[12.5px]">{k}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/**
 * "Create your own GitHub App in one click": the manifest swarmy posts to
 * GitHub, shown before you go — name, webhook, permissions, events — then one
 * coral button. GitHub creates the App under your account or org and sends
 * you back; the private key and webhook secret go straight into the vault.
 */
export function GitManifestPreview({ webBase, hostField, returnTo }: GitManifestPreviewProps): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [org, setOrg] = React.useState('');
  const owner = useDebouncedValue(org.trim(), 400);
  const input = { ...(owner ? { githubOrg: owner } : {}), ...(webBase !== GITHUB_WEB ? { webBase } : {}) };
  const preview = useGithubManifest(input);
  const start = useMutation(
    trpc.gitConnections.startGithubManifest.mutationOptions({
      onSuccess: ({ postUrl, manifest }) => {
        rememberGitReturn(returnTo ? { to: returnTo, created: webBase } : null);
        postGithubManifest(postUrl, manifest, navigate);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const m = preview.data;
  const host = hostOf(webBase);

  return (
    <section aria-label="Create your own GitHub App" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 className="font-display text-[16.5px] font-bold tracking-[-0.01em]">Create your own GitHub App in one click</h2>
        <GitChip tone="mesh">manifest flow</GitChip>
        <span className="text-muted-foreground text-xs xl:ml-auto">Your app, your org — swarmy never holds a shared key</span>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-w-0 flex-col gap-2.5">
          <Row k="GitHub host">{hostField}</Row>
          <Row k="Owner">
            <Input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="your account (or a GitHub org)" aria-label="GitHub org" className="h-8 max-w-xs" />
          </Row>
          {preview.isPending ? (
            <TextSkeleton className="h-20 w-full rounded-xl" />
          ) : preview.isError ? (
            <p className="text-muted-foreground text-sm">Couldn’t build the app yet: {preview.error.message}</p>
          ) : m ? (
            <>
              <Row k="App name"><span className="font-mono text-[12.5px]">{m.name}</span></Row>
              <Row k="Webhook"><span className="font-mono text-[12.5px] break-all">{m.webhook ?? '—'}</span></Row>
              <Row k="Permissions">{m.permissions.map((p) => <GitChip key={p} mono>{p}</GitChip>)}</Row>
              <Row k="Events">{m.events.map((e) => <GitChip key={e} mono>{e}</GitChip>)}</Row>
            </>
          ) : null}
        </div>
        <div className="flex flex-col gap-2.5">
          <p className="text-muted-foreground text-[13px] leading-snug">
            We pre-fill everything. You click <b className="text-foreground">Create</b> once on GitHub and land back here.
          </p>
          <Button onClick={() => start.mutate(input)} disabled={!m || start.isPending} className="h-auto min-h-9 py-2 whitespace-normal pointer-coarse:min-h-11">
            {start.isPending ? 'Opening GitHub…' : `Create app on ${host} ↗`}
          </Button>
          <span className="text-muted-foreground font-mono text-[11px] leading-relaxed">
            GitLab? Pick GitLab or Self-hosted — sign in, or paste an access token with the api scope.
          </span>
        </div>
      </div>
    </section>
  );
}
