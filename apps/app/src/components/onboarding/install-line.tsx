import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { InfoIcon } from 'lucide-react';
import { CopyButton, cn } from '@swarmy/ui';
import { AlreadyOn, Tech } from '@/components/calm';
import { ControllerUrlWarning, installOneLiner } from './install-command-panel';
import type { NodeRoleChoice } from './node-role-picker';
import { cloudConfig, platformOf, type PlatformId } from './platforms';
import type { JoinLink } from './use-join-link';

function minutesLeft(at: Date): number {
  return Math.max(0, Math.round((at.getTime() - Date.now()) / 60_000));
}

/** What only this platform needs saying, from the link it carries. */
function PlatformNote({ platform, link }: { platform: PlatformId; link: JoinLink }): React.JSX.Element | null {
  if (platformOf(platform).cloudConfig) {
    return <>The link inside works once and expires in {minutesLeft(link.expiresAt)} min, so create the server before then.</>;
  }
  if (platform !== 'nat') return null;
  if (!link.mesh) {
    return (
      <span className="text-tone-warn">
        Your private network is off, so your other servers can&apos;t reach one behind a router.{' '}
        <Link to="/networking/settings" className="underline underline-offset-2">Turn it on first</Link>, then make a new link.
      </span>
    );
  }
  return (
    <>
      It joins your private network first, which finds a way through your router. swarmy notes it&apos;s behind NAT, so when a server
      retires the front door, storage and swarm management never move onto it.
    </>
  );
}

/** The one line to paste on the new server (or the cloud-config for a cloud), and what's already handled. */
export function InstallLine({
  link,
  role,
  labels,
  platform,
  done,
}: {
  link: JoinLink | null;
  role: NodeRoleChoice;
  labels: string;
  platform: PlatformId;
  /** The server has joined: the copy button goes quiet (the receipt's action is the one now). */
  done?: boolean;
}): React.JSX.Element {
  const p = platformOf(platform);
  const line = link ? installOneLiner(link.token, labels, role, link.mesh, link.target) : null;
  const text = line && p.cloudConfig ? cloudConfig(line) : line;
  const copyCls = done
    ? 'pointer-coarse:min-h-11 shrink-0'
    : 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground pointer-coarse:min-h-11 shrink-0 border-transparent';
  return (
    <div className="flex flex-col gap-4">
      <div className={cn('calm-card flex gap-3 px-4 py-3.5', p.cloudConfig ? 'items-start' : 'items-center')}>
        {text ? (
          <>
            <code
              tabIndex={0}
              aria-label={p.cloudConfig ? 'Cloud config' : 'Install command'}
              className={cn('min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-pre', p.cloudConfig && 'leading-relaxed')}
            >
              {p.cloudConfig ? null : <span aria-hidden className="text-muted-foreground select-none">$ </span>}
              {text}
            </code>
            <CopyButton value={text} label="Copy" className={copyCls} />
          </>
        ) : (
          <span className="shimmer-line block h-6 w-full rounded-md" aria-label="Making your link" />
        )}
      </div>
      <ControllerUrlWarning target={link?.target} />
      <p className="text-muted-foreground flex items-start gap-2 text-[13px] leading-relaxed">
        <InfoIcon aria-hidden className="text-tone-info mt-[3px] size-3.5 shrink-0" />
        <span>
          {p.hint}
          {link ? <> <PlatformNote platform={platform} link={link} /></> : null}
        </span>
      </p>
      <div className="flex flex-col gap-2">
        <h2 className="calm-eyebrow">Already handled</h2>
        <AlreadyOn
          bare
          items={[
            {
              what: 'Single-use',
              detail: link ? `the link works once and expires in ${minutesLeft(link.expiresAt)} min` : 'the link works once',
            },
            {
              what: 'Private network',
              detail: link?.mesh ? 'it joins your private network before anything else, behind NAT too' : 'it dials home over HTTPS, nothing to open on your firewall',
            },
            {
              what: 'Its job',
              detail: role === 'auto' ? 'swarmy picks its role; the first server runs swarmy itself' : `it joins as a ${role}`,
            },
          ]}
        />
      </div>
      <Tech>
        {link ? `token ${link.token.split('_').slice(0, 2).join('_')}… · ` : ''}
        {role === 'auto' ? 'role hint: none' : `SWARMY_ROLE_HINT=${role}`}
        {labels.trim() ? ` · SWARMY_NODE_LABELS=${labels.trim()}` : ''}
        {link?.mesh ? ` · mesh ${link.mesh.driver ?? 'netbird'}` : ''}
        {p.cloudConfig ? ' · cloud-init runcmd (root, first boot)' : ''}
      </Tech>
    </div>
  );
}
