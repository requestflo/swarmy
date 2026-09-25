import * as React from 'react';
import { InfoIcon } from 'lucide-react';
import { CopyButton } from '@swarmy/ui';
import { AlreadyOn, Tech } from '@/components/calm';
import { ControllerUrlWarning, installOneLiner } from './install-command-panel';
import type { NodeRoleChoice } from './node-role-picker';
import type { JoinLink } from './use-join-link';

function minutesLeft(at: Date): number {
  return Math.max(0, Math.round((at.getTime() - Date.now()) / 60_000));
}

/** The one line to paste on the new server, and what's already handled. */
export function InstallLine({
  link,
  role,
  labels,
  done,
}: {
  link: JoinLink | null;
  role: NodeRoleChoice;
  labels: string;
  /** The server has joined: the copy button goes quiet (Open is the action now). */
  done?: boolean;
}): React.JSX.Element {
  const line = link ? installOneLiner(link.token, labels, role, link.mesh, link.target) : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="calm-card flex items-center gap-3 px-4 py-3.5">
        {line ? (
          <>
            <code tabIndex={0} aria-label="Install command" className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap">
              <span aria-hidden className="text-muted-foreground select-none">$ </span>
              {line}
            </code>
            <CopyButton value={line} label="Copy" className={done ? 'pointer-coarse:min-h-11 shrink-0' : 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground pointer-coarse:min-h-11 shrink-0 border-transparent'} />
          </>
        ) : (
          <span className="shimmer-line block h-6 w-full rounded-md" aria-label="Making your link" />
        )}
      </div>
      <ControllerUrlWarning target={link?.target} />
      <p className="text-muted-foreground flex items-start gap-2 text-[13px]">
        <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        Any Linux: Ubuntu, Debian, Fedora, Alpine, on x86 or ARM. Docker is installed for you if it's missing.
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
              detail: link?.mesh ? 'it joins your private network before anything else' : 'it dials home over HTTPS, nothing to open on your firewall',
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
      </Tech>
    </div>
  );
}
