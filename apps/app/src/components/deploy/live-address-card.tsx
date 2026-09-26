import * as React from 'react';
import { ArrowUpRightIcon, CheckIcon, LockIcon, UnlockIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import type { DeployDomain } from './deploy-steps';

function CopyAddress({ value }: { value: string }): React.JSX.Element {
  const [done, setDone] = React.useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(value).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1_600);
    });
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} className="pointer-coarse:min-h-11" aria-label={`Copy ${value}`}>
      {done ? <CheckIcon aria-hidden className="size-4" /> : null}
      {done ? 'Copied' : 'Copy'}
    </Button>
  );
}

/**
 * The address card (board "It's live"): the lock, the mono URL, Copy, and the
 * screen's one coral action, Open ↗ (a real link, new tab).
 */
export function LiveAddressCard({ domain }: { domain: DeployDomain }): React.JSX.Element {
  const secure = domain.tls !== 'off';
  const url = `${secure ? 'https' : 'http'}://${domain.host}`;
  return (
    <div className="calm-card border-primary/30 flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 sm:flex-nowrap">
      {secure ? (
        <LockIcon aria-label="HTTPS" className="text-tone-ok size-4 shrink-0" />
      ) : (
        <UnlockIcon aria-label="Plain HTTP" className="text-tone-warn size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 basis-[14rem] font-mono text-[15px] font-semibold break-all">{domain.host}</span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <CopyAddress value={url} />
        <Button asChild size="sm" className="pointer-coarse:min-h-11">
          <a href={url} target="_blank" rel="noreferrer">
            Open <ArrowUpRightIcon aria-hidden className="size-4" />
            <span className="sr-only"> {domain.host} in a new tab</span>
          </a>
        </Button>
      </div>
    </div>
  );
}
