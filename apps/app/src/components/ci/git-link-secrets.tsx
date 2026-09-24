import * as React from 'react';
import { KeyRoundIcon } from 'lucide-react';
import type { LinkedRepo } from './git-types';
import { GitSecretField } from './git-secret-field';

/** The one-time reveal after linking: webhook URL + secret, and/or a deploy key. */
export function GitLinkSecrets({ linked }: { linked: LinkedRepo }): React.JSX.Element | null {
  if (!linked.webhook && !linked.deployKeyPublic) {
    return (
      <p className="text-muted-foreground text-sm">
        Pushes reach swarmy on their own — nothing to paste into your git host.
      </p>
    );
  }
  return (
    <div className="border-status-warning/30 space-y-3 rounded-2xl border p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <KeyRoundIcon className="text-status-warning size-4" /> Copy these now — we won’t show them
        again.
      </p>
      {linked.webhook ? (
        <>
          <p className="text-muted-foreground text-sm">
            Add a push webhook in your git host with this URL and secret.
          </p>
          <GitSecretField label="Webhook URL" value={linked.webhook.url} />
          <GitSecretField label="Webhook secret" value={linked.webhook.secret} />
        </>
      ) : null}
      {linked.deployKeyPublic ? (
        <>
          <p className="text-muted-foreground text-sm">
            Add this as a read-only deploy key on the repo.
          </p>
          <GitSecretField label="Deploy key (public)" value={linked.deployKeyPublic} wrap />
        </>
      ) : null}
    </div>
  );
}
