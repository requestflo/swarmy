import { Link } from '@tanstack/react-router';
import { MenuIcon, SparklesIcon } from 'lucide-react';
import { Button } from '@swarmy/ui/components/button';
import { DEMO_URL, GITHUB_URL } from '@/lib/site';
import { Logo } from './logo';

const NAV = [
  { to: '/features', label: 'Features' },
  { to: '/compare', label: 'Compare' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/blog', label: 'Blog' },
] as const;

export function SiteHeader() {
  return (
    <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
        <Link to="/" aria-label="swarmy home">
          <Logo />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          <Link
            to="/docs/$"
            params={{ _splat: '' }}
            className="text-muted-foreground hover:text-foreground rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
          >
            Docs
          </Link>
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="text-muted-foreground hover:text-foreground rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
              activeProps={{ className: 'text-foreground' }}
            >
              {n.label}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            className="text-muted-foreground hover:text-foreground rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
          >
            GitHub
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" className="hidden sm:inline-flex">
            <a href={DEMO_URL}>
              <SparklesIcon aria-hidden /> Live demo
            </a>
          </Button>
          <Button asChild>
            <Link to="/docs/$" params={{ _splat: 'getting-started/install' }}>
              Install
            </Link>
          </Button>
          <details className="relative md:hidden">
            <summary
              aria-label="Menu"
              className="hover:bg-accent flex size-9 cursor-pointer list-none items-center justify-center rounded-full [&::-webkit-details-marker]:hidden"
            >
              <MenuIcon className="size-5" aria-hidden />
            </summary>
            <nav
              aria-label="Mobile"
              className="bg-popover absolute right-0 mt-2 flex w-48 flex-col rounded-2xl border p-2 shadow-xl"
            >
              <Link
                to="/docs/$"
                params={{ _splat: '' }}
                className="hover:bg-accent rounded-xl px-3 py-2 text-sm"
              >
                Docs
              </Link>
              {NAV.map((n) => (
                <Link key={n.to} to={n.to} className="hover:bg-accent rounded-xl px-3 py-2 text-sm">
                  {n.label}
                </Link>
              ))}
              <a href={GITHUB_URL} className="hover:bg-accent rounded-xl px-3 py-2 text-sm">
                GitHub
              </a>
              <a href={DEMO_URL} className="hover:bg-accent rounded-xl px-3 py-2 text-sm">
                Live demo
              </a>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
