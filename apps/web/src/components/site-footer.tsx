import { Link } from '@tanstack/react-router';
import { GITHUB_URL } from '@/lib/site';
import { Logo } from './logo';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { to: '/features', label: 'Features' },
      { to: '/compare', label: 'Compare' },
      { to: '/pricing', label: 'Pricing' },
      { to: '/blog', label: 'Blog' },
    ],
  },
  {
    title: 'Docs',
    links: [
      { to: '/docs/getting-started/quickstart', label: 'Quickstart' },
      { to: '/docs/getting-started/install', label: 'Install' },
      { to: '/docs/guides/deploy-from-git', label: 'Deploy from git' },
      { to: '/docs/reference/api', label: 'API reference' },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="flex flex-col gap-3">
          <Logo />
          <p className="text-muted-foreground max-w-xs text-sm">
            Your own cloud, on your own servers. Open source under FSL-1.1, converting to Apache
            2.0.
          </p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <p className="mono-label mb-3">{col.title}</p>
            <ul className="flex flex-col gap-2 text-sm">
              {col.links.map((l) => (
                <li key={l.to}>
                  <a href={l.to} className="text-muted-foreground hover:text-foreground">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <p className="mono-label mb-3">Community</p>
          <ul className="flex flex-col gap-2 text-sm">
            <li>
              <a href={GITHUB_URL} className="text-muted-foreground hover:text-foreground">
                GitHub
              </a>
            </li>
            <li>
              <a
                href={`${GITHUB_URL}/issues`}
                className="text-muted-foreground hover:text-foreground"
              >
                Issues
              </a>
            </li>
            <li>
              <Link
                to="/docs/$"
                params={{ _splat: '' }}
                className="text-muted-foreground hover:text-foreground"
              >
                Documentation
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="text-muted-foreground border-t py-6 text-center text-xs">
        swarm<span className="text-primary">y</span> · FSL-1.1-ALv2
      </div>
    </footer>
  );
}
