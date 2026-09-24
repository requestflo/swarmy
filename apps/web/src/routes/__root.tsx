import type { ReactNode } from 'react';
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { RootProvider } from 'fumadocs-ui/provider/tanstack';
import appCss from '@/styles.css?url';
import { seo } from '@/lib/seo';

export const Route = createRootRoute({
  head: () => {
    const base = seo({ path: '/' });
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#10152a' },
        // Per-route head() overrides title/description/og:* (TanStack dedupes by name/property).
        ...base.meta,
      ],
      links: [
        { rel: 'stylesheet', href: appCss },
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'sitemap', type: 'application/xml', href: '/sitemap.xml' },
      ],
    };
  },
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-background text-foreground flex min-h-screen flex-col">
        <RootProvider
          // Hot Signal is dark-first on the marketing site; the docs keep the toggle.
          theme={{ defaultTheme: 'dark', enableSystem: false }}
          // The index is prerendered to /api/search; query it in the browser.
          search={{ options: { type: 'static' } }}
        >
          {children}
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
