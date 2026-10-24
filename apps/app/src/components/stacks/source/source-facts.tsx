import * as React from 'react';
import type { AppConfig } from '@swarmy/app-config';
import { Section } from '@/components/calm';
import type { GitApp } from '@/components/gitops/gitops-types';
import { agoWords } from '@/components/app-tabs/releases/release-label';
import { ToneChip } from './tone-chip';
import type { ConfigFileView } from './use-config-file';

function Row({ k, children, chip }: { k: string; children: React.ReactNode; chip?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b py-1.5 text-[13px] last:border-b-0">
      <span className="text-muted-foreground w-28 shrink-0 text-[12.5px] font-semibold">{k}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {chip ? <span className="ml-auto">{chip}</span> : null}
    </div>
  );
}

const repoName = (app: GitApp): string => app.fullName ?? app.url.replace(/^https?:\/\//, '').replace(/\.git$/, '');

/**
 * Source (board YamlEditor's sidebar): where the file lives and what a push
 * does — the git binding's repo, path and branch, whether a push deploys
 * straight away or waits for approval, previews from the saved swarmy.yaml,
 * and when the last webhook (or poll) brought a commit in.
 */
export function SourceFacts({ app, branch, file, saved }: { app: GitApp; branch: string; file: ConfigFileView; saved: AppConfig | undefined }): React.JSX.Element {
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '/';
  const previews = saved?.previews?.enabled ?? false;
  const base = saved?.previews?.base_domain ?? file.previewDomain;
  const heard = file.lastWebhookAt ? (
    <ToneChip tone="ok">webhook ok · {agoWords(file.lastWebhookAt)}</ToneChip>
  ) : file.lastPollAt ? (
    <ToneChip tone="idle">polling · {agoWords(file.lastPollAt)}</ToneChip>
  ) : null;
  return (
    <Section title="Source" action={heard} flush>
      <div className="flex flex-col">
        <Row k="Repo" chip={<span className="text-muted-foreground font-mono text-xs">path {dir}</span>}>
          <span className="font-mono text-[12px]">{repoName(app)}</span>
        </Row>
        <Row k="Branch">
          <span className="font-mono text-[12px]">
            {branch} · {file.sha.slice(0, 7)}
          </span>
        </Row>
        <Row
          k={`Push to ${branch}`}
          chip={app.requireApproval ? <ToneChip tone="warn">approval on</ToneChip> : <ToneChip tone="ok">autodeploy on</ToneChip>}
        >
          {app.requireApproval ? 'Plans it, then waits for you' : 'Build, then deploy'}
        </Row>
        <Row k="Pull requests" chip={previews ? <ToneChip tone="info">previews on</ToneChip> : <ToneChip tone="idle">previews off</ToneChip>}>
          {previews ? (base ? <>Preview at <span className="font-mono text-[12px]">pr-&lt;N&gt;.{base}</span></> : 'Previews on, once a base domain is set') : 'No previews'}
        </Row>
      </div>
    </Section>
  );
}
