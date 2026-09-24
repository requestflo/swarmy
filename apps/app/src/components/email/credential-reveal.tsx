import * as React from 'react';
import { KeyRoundIcon, XIcon } from 'lucide-react';
import { Button, CopyButton } from '@swarmy/ui';

export interface RevealedCredential {
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
  apiKey: string;
  apiUrl: string;
  webhookSecret: string | null;
}

/** Inline strip with a credential's SMTP login, API key and webhook secret. */
export function CredentialReveal({ credential: c, onDismiss }: { credential: RevealedCredential; onDismiss: () => void }): React.JSX.Element {
  const rows: Array<[string, string]> = [
    ['SMTP_HOST', c.smtpHost],
    ['SMTP_PORT', String(c.smtpPort)],
    ['SMTP_USER', c.username],
    ['SMTP_PASS', c.password],
    ['EMAIL_API_URL', c.apiUrl],
    ['EMAIL_API_KEY', c.apiKey],
    ...(c.webhookSecret ? ([['Webhook secret', c.webhookSecret]] as Array<[string, string]>) : []),
  ];
  return (
    <div className="border-primary/40 bg-primary/5 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
          <KeyRoundIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-semibold">Keep these secret.</p>
          <p className="text-muted-foreground text-xs">
            SMTP is in-cluster only (no TLS on the encrypted overlay). Outside the cluster, use the HTTP API. Webhooks are signed:
            <code className="mono-data"> X-Swarmy-Signature: t=…,v1=HMAC-SHA256(secret, t.body)</code>.
          </p>
          {rows.map(([k, v]) => (
            <div key={k} className="bg-card flex items-center justify-between gap-2 rounded-md border px-3 py-1.5">
              <span className="mono-label text-muted-foreground w-32 shrink-0">{k}</span>
              <code className="mono-data min-w-0 flex-1 truncate text-xs">{v}</code>
              <CopyButton value={v} />
            </div>
          ))}
        </div>
        <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
