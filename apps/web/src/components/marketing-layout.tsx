import type { ReactNode } from 'react';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

export function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-full px-4 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}

/** A page intro block shared by the inner marketing pages. */
export function PageIntro({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="mesh">
      <div className="mx-auto max-w-4xl px-6 pt-20 pb-14 text-center">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="headline mt-6 text-4xl sm:text-5xl">{title}</h1>
        {children ? (
          <div className="text-muted-foreground mx-auto mt-6 max-w-2xl text-lg">{children}</div>
        ) : null}
      </div>
    </section>
  );
}

export function ComingTag() {
  return <span className="coming-tag">Coming</span>;
}
