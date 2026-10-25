import * as React from 'react';
import { CalmRow, Depth, RowList, Section } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { ProvidersTab } from './providers-tab';
import { applySsoOnly } from './sso-only-words';
import { SsoOnlyCard } from './sso-only-card';
import { SsoTab } from './sso-tab';
import type { SignInMethod } from './use-signin-methods';
import { useSsoOnly } from './use-sso-only';

/**
 * Sign-in: the ways in, on or off, and whether members may only use company
 * sign-in (the password row then reads as the owners' break-glass). Add
 * company sign-in and rotate secrets from Controls.
 */
export function SignInSection({ methods, role }: { methods: SignInMethod[] | undefined; role: 'owner' | 'admin' | 'member' | undefined }): React.JSX.Element {
  const ssoOnly = useSsoOnly();
  if (!methods) return <CardSkeleton lines={3} />;
  const rows = applySsoOnly(methods, ssoOnly?.on === true);
  return (
    <Section id="sign-in" title="Sign-in" hint={ssoOnly?.on ? 'company sign-in only' : 'company sign-in first, the rest are fallbacks'} flush>
      <RowList label="Sign-in methods">
        {rows.map((m) => (
          <CalmRow
            key={m.id}
            tone={m.word === 'Owners' ? 'warn' : m.enabled ? 'ok' : 'idle'}
            name={m.label}
            say={m.detail}
            tech={m.tech}
            word={m.word ?? (m.enabled ? 'On' : 'Off')}
          />
        ))}
      </RowList>
      {role ? <SsoOnlyCard role={role} /> : null}
      <Depth at="controls">
        <div className="flex flex-col gap-5 pt-3 pb-3">
          <h3 className="calm-eyebrow">Company sign-in (OIDC or SAML)</h3>
          <SsoTab />
          <h3 className="calm-eyebrow">Google, Microsoft, GitHub, GitLab and passwordless</h3>
          <ProvidersTab />
        </div>
      </Depth>
    </Section>
  );
}
