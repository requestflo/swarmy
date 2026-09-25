import * as React from 'react';
import { ShieldCheckIcon } from 'lucide-react';
import { Wordmark } from '@/components/wordmark';

/**
 * The sign-in screens (RSignIn board): the form on the left, a quiet brand
 * panel on the right (wide screens only). Nothing about the team shows before
 * sign-in — publicConfig carries no org data — so the panel says only what is
 * true of every swarmy: where you are signing in, and that it stays there.
 */
export function SignInLayout({
  title,
  lede,
  children,
  foot,
}: {
  title: React.ReactNode;
  lede?: React.ReactNode;
  children: React.ReactNode;
  /** Quiet notes pinned to the bottom of the form column. */
  foot?: React.ReactNode;
}): React.JSX.Element {
  const host = typeof window === 'undefined' ? '' : window.location.host;
  return (
    <div className="bg-background flex min-h-screen">
      <main className="flex w-full flex-col px-6 py-10 sm:px-12 lg:w-[560px] lg:shrink-0 lg:px-20 lg:py-16">
        <div className="flex items-center gap-3">
          <Wordmark className="text-2xl" />
          {host ? <span className="text-muted-foreground font-mono text-[12px]">{host}</span> : null}
        </div>
        <div className="mt-10 flex max-w-[420px] flex-col gap-2 lg:mt-12">
          <h1 className="say text-[2.2rem] sm:text-[2.5rem]">{title}</h1>
          {lede ? <p className="lede text-[15px]">{lede}</p> : null}
        </div>
        <div className="mt-8 w-full max-w-[420px]">{children}</div>
        {foot ? <div className="border-border text-muted-foreground mt-auto max-w-[420px] border-t pt-4 text-[12.5px] leading-relaxed">{foot}</div> : null}
      </main>
      <aside
        aria-hidden
        className="border-border relative hidden flex-1 overflow-hidden border-l lg:block"
        style={{ background: 'radial-gradient(900px 600px at 70% 40%, color-mix(in oklch, var(--nav) 70%, var(--primary) 6%), var(--nav))' }}
      >
        <div className="absolute inset-0 flex items-center justify-center">
          {[520, 360, 220].map((d) => (
            <span key={d} className="border-primary/20 absolute rounded-full border" style={{ width: d, height: d }} />
          ))}
          <span className="bg-primary size-10 rounded-full" />
        </div>
        <div className="text-nav-foreground absolute top-16 left-16 flex max-w-md flex-col gap-3">
          <span className="calm-eyebrow" style={{ color: 'var(--nav-muted)' }}>{host ? `${host} · swarmy` : 'swarmy'}</span>
          <p className="font-display text-[2rem] leading-[1.08] font-bold tracking-[-0.025em]">
            Your apps, on your own servers.
          </p>
        </div>
        <div className="border-[var(--nav-line)] bg-[var(--nav-hover)] text-nav-muted absolute bottom-16 left-16 flex max-w-sm gap-3 rounded-2xl border p-4">
          <ShieldCheckIcon className="text-status-online mt-0.5 size-4 shrink-0" />
          <p className="text-[13px] leading-relaxed">
            Signing in is checked by this server. Nothing about your team is shown until you are signed in.
          </p>
        </div>
      </aside>
    </div>
  );
}
