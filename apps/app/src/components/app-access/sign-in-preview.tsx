import * as React from 'react';
import { END_USER_AUTH_APP_SNIPPET } from '@swarmy/templates';
import { Tech } from '@/components/calm';
import type { EndUserAuth } from './types';

const LABELS: Record<string, string> = { google: 'Google', github: 'GitHub', microsoft: 'Microsoft', oidc: 'SSO' };

const CLIENT_SNIPPET = `// in the browser
import { createAuthClient } from '@swarmy/app-auth/client';
const auth = createAuthClient();
await auth.signIn('github');   // or link to auth.hostedLoginUrl()`;

/**
 * The app's own sign-in, as its customers see it: a preview of the hosted
 * page the auth service serves at /auth/login (`hostedLoginUrl()` in
 * @swarmy/app-auth/client) for the providers and email mode in swarmy.yaml,
 * and the SDK lines the app uses.
 */
export function SignInPreview({ stack, auth }: { stack: string; auth: EndUserAuth }): React.JSX.Element {
  const email = auth.email === 'magic-link' || auth.email === 'password' ? auth.email : null;
  const nothing = auth.providers.length === 0 && !email;
  return (
    <section className="flex flex-col gap-3" aria-label="Your customers’ sign-in">
      <div className="flex flex-col gap-0.5">
        <span className="calm-eyebrow">What your customers see · /auth/login</span>
        <Tech>{auth.serviceName} · providers and email mode from auth: in swarmy.yaml</Tech>
      </div>
      <div className="grid gap-3 md:grid-cols-[260px_1fr]">
        <div aria-label="Sign-in page preview" className="bg-card flex flex-col gap-1.5 rounded-xl border p-4">
          <span className="mb-1 text-[14px] font-bold">Sign in to {stack}</span>
          {auth.providers.map((p) => (
            <Fake key={p}>Continue with {LABELS[p] ?? p}</Fake>
          ))}
          {auth.providers.length > 0 && email ? <span className="text-muted-foreground text-center text-[11px]">or</span> : null}
          {email ? (
            <>
              <Fake muted>you@example.com</Fake>
              {email === 'password' ? <Fake muted>Password</Fake> : null}
              <Fake strong>{email === 'magic-link' ? 'Email me a sign-in link' : 'Sign in'}</Fake>
            </>
          ) : null}
          {nothing ? <span className="text-tone-bad text-xs">Turn on at least one way to sign in.</span> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="calm-eyebrow">In your app</span>
          <pre className="calm-code overflow-x-auto px-3 py-2.5 text-[11.5px]">{`${END_USER_AUTH_APP_SNIPPET}\n${CLIENT_SNIPPET}`}</pre>
        </div>
      </div>
    </section>
  );
}

/** A non-interactive stand-in for one control on the hosted page. */
function Fake({ children, muted, strong }: { children: React.ReactNode; muted?: boolean; strong?: boolean }): React.JSX.Element {
  return (
    <span
      className={
        strong
          ? 'bg-foreground text-background rounded-lg px-3 py-1.5 text-center text-[12.5px] font-semibold'
          : muted
            ? 'text-muted-foreground rounded-lg border px-3 py-1.5 text-[12.5px]'
            : 'rounded-lg border px-3 py-1.5 text-center text-[12.5px] font-semibold'
      }
    >
      {children}
    </span>
  );
}
