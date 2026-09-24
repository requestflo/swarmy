import * as React from 'react';
import { Building2Icon, GithubIcon, GitlabIcon, KeyRoundIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
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
      {options.map((o) => {
        const Icon = o.kind === 'sso' ? KeyRoundIcon : (ICONS[o.id] ?? KeyRoundIcon);
        return (
          <Button key={`${o.kind}:${o.id}`} type="button" variant="outline" className="w-full" disabled={pending !== null} onClick={() => void go(o)}>
            <Icon className="size-4" />
            Continue with {o.label}
          </Button>
        );
      })}
    </div>
  );
}

/** "or" rule between the provider buttons and the password form. */
export function OrDivider(): React.JSX.Element {
  return (
    <div className="text-muted-foreground my-5 flex items-center gap-3 text-xs">
      <span className="bg-border h-px flex-1" />
      or use a username
      <span className="bg-border h-px flex-1" />
    </div>
  );
}
