import * as React from 'react';
import { CalmRow, Depth, RowList, Section } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { ProvidersTab } from './providers-tab';
import { SsoTab } from './sso-tab';
import type { SignInMethod } from './use-signin-methods';

/** Sign-in: the ways in, on or off. Turn them on, add company sign-in, rotate secrets from Controls. */
export function SignInSection({ methods }: { methods: SignInMethod[] | undefined }): React.JSX.Element {
  if (!methods) return <CardSkeleton lines={3} />;
  return (
    <Section id="sign-in" title="Sign-in" hint="company sign-in first, the rest are fallbacks" flush>
      <RowList label="Sign-in methods">
        {methods.map((m) => (
          <CalmRow key={m.id} tone={m.enabled ? 'ok' : 'idle'} name={m.label} say={m.detail} tech={m.tech} word={m.enabled ? 'On' : 'Off'} />
        ))}
      </RowList>
      <Depth at="controls">
        <div className="flex flex-col gap-5 pt-3 pb-3">
          <h3 className="calm-eyebrow">Company sign-in (OIDC)</h3>
          <SsoTab />
          <h3 className="calm-eyebrow">Google, Microsoft, GitHub, GitLab and passwordless</h3>
          <ProvidersTab />
        </div>
      </Depth>
    </Section>
  );
}
