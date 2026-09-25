import * as React from 'react';
import { Building2Icon, GithubIcon, GitlabIcon, KeyRoundIcon } from 'lucide-react';
import { Button, cn, toast } from '@swarmy/ui';
import { authClient } from '@swarmy/auth/client';

export interface SignInOption {
  kind: 'social' | 'sso';
  id: string;
  label: string;
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  github: GithubIcon,
  gitlab: GitlabIcon,
  microsoft: Building2Icon,
};

interface SignInOptionsProps {
  options: SignInOption[];
  /** Where the IdP sends the browser back to once signed in. */
  callbackURL: string;
}

/**
 * The SSO / social buttons: the primary way in. Org OIDC providers (Keycloak,
 * Authentik, Zitadel, Entra ID…) come first, then Microsoft, Google, GitHub,
 * GitLab. Each leaves the page for the IdP and comes back to `callbackURL`.
 */
export function SignInOptions({ options, callbackURL }: SignInOptionsProps): React.JSX.Element | null {
  const [pending, setPending] = React.useState<string | null>(null);
  if (options.length === 0) return null;

  async function go(o: SignInOption): Promise<void> {
    setPending(o.id);
    const errorCallbackURL = '/login';
    const res =
      o.kind === 'sso'
        ? await authClient.signIn.oauth2({ providerId: o.id, callbackURL, errorCallbackURL })
        : await authClient.signIn.social({ provider: o.id, callbackURL, errorCallbackURL });
    if (res.error) {
      setPending(null);
      toast.error(res.error.message ?? `could not start ${o.label} sign-in`);
    }
  }

  return (
    <div className="grid gap-2">
      {options.map((o, i) => {
        const Icon = o.kind === 'sso' ? KeyRoundIcon : (ICONS[o.id] ?? KeyRoundIcon);
        const first = i === 0;
        return (
          <Button
            key={`${o.kind}:${o.id}`}
            type="button"
            variant="outline"
            className={cn('w-full justify-start gap-3 pointer-coarse:min-h-11', first && 'border-primary/60 h-12 text-[15px]')}
            disabled={pending !== null}
            onClick={() => void go(o)}
          >
            <Icon aria-hidden className="size-4" />
            <span className="flex-1 text-left">
              {pending === o.id ? `Opening ${o.label}…` : o.kind === 'sso' ? `Company sign-in (${o.label})` : `Continue with ${o.label}`}
            </span>
            {first && options.length > 1 ? <span className="text-muted-foreground text-xs font-medium">your team uses this</span> : null}
          </Button>
        );
      })}
      <p className="text-muted-foreground px-1 pt-1 text-xs">Use the account your team already has. It checks its own two-factor, so swarmy never asks twice.</p>
    </div>
  );
}

/** "or" rule between the provider buttons and the password form. */
export function OrDivider(): React.JSX.Element {
  return (
    <div className="text-muted-foreground my-5 flex items-center gap-3 text-xs">
      <span className="bg-border h-px flex-1" />
      or sign in with a username
      <span className="bg-border h-px flex-1" />
    </div>
  );
}
