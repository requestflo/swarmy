import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_TEXT, Tech } from '@/components/calm';
import { GitSecretField } from './git-secret-field';
import { GITEA_CALLBACK_PATH, GITEA_SCOPES, giteaTestLine, type GiteaMode, type GiteaTest } from './git-gitea-model';

/** What to create on the Gitea / Forgejo side: a token's scopes, or the OAuth app's redirect URI. */
export function GiteaSetupHint({ mode }: { mode: GiteaMode }): React.JSX.Element {
  if (mode === 'oauth') {
    const callback = `${typeof window === 'undefined' ? '' : window.location.origin}${GITEA_CALLBACK_PATH}`;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[12.5px]">
          On your server, open Settings → Applications and add an OAuth2 application with this redirect URI.
        </p>
        <GitSecretField label="Redirect URI" value={callback} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-[12.5px]">
        Make one under Settings → Applications → Generate new token, with these permissions:
      </p>
      <ul className="flex flex-col gap-1">
        {GITEA_SCOPES.map((s) => (
          <li key={s.scope} className="text-[12.5px] leading-snug">
            <span className="text-foreground font-mono">{s.scope}</span>
            <span className="text-muted-foreground"> · {s.why}</span>
          </li>
        ))}
      </ul>
      <Tech>Read-only works for builds; webhooks, statuses and preview comments need the write scopes.</Tech>
    </div>
  );
}

/** The one sentence a "Test connection" answers with. */
export function GiteaTestResultLine({ result }: { result: GiteaTest }): React.JSX.Element {
  const line = giteaTestLine(result);
  return (
    <p role="status" className={cn('text-[13px] leading-snug', TONE_TEXT[line.tone])}>
      {line.text}
    </p>
  );
}
