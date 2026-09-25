/**
 * Site-wide constants. Everything that differs per deploy is a VITE_* env
 * var read at build time (the site is prerendered, so these are baked in).
 */

/** Canonical origin of this site — used for canonical links, OG tags and the sitemap. */
export const SITE_URL: string = (import.meta.env.VITE_SITE_URL ?? 'https://swarmy.dev').replace(
  /\/$/,
  '',
);

/**
 * The public "Live demo": the dashboard built in demo mode (apps/app/demo.Dockerfile),
 * fake data and no backend. ONE value per deploy, DEMO_URL (the Dockerfile passes it
 * in as VITE_DEMO_URL). It lives at https://demo.ayebox.com for now. For local dev, point it at the dev dashboard's demo mode:
 * VITE_DEMO_URL='http://localhost:3023/?demo=1'.
 */
export const DEMO_URL: string = import.meta.env.VITE_DEMO_URL || 'https://demo.ayebox.com';

/** Where "the dashboard" links go. Defaults to the live demo (VITE_APP_URL overrides). */
export const APP_URL: string = import.meta.env.VITE_APP_URL || DEMO_URL;

export const GITHUB_URL = 'https://github.com/requestflo/swarmy';

/** The one-line install, exactly as the Getting Started guide prints it. */
export const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/requestflo/swarmy/main/scripts/install-swarmy.sh | sudo bash';

export const SITE_NAME = 'swarmy';
export const SITE_TAGLINE = 'Your own cloud, on your own servers.';
export const SITE_DESCRIPTION =
  'swarmy turns any set of Linux servers into your own cloud: git deploys, managed Postgres with backups, a geo-DNS edge, a WireGuard mesh and observability. Self-hosted, open source, no cloud dependency.';

/** Top-level marketing routes, in nav order. The sitemap lists these plus every docs page. */
export const MARKETING_ROUTES = [
  { path: '/', label: 'Home' },
  { path: '/features', label: 'Features' },
  { path: '/compare', label: 'Compare' },
  { path: '/pricing', label: 'Pricing' },
  { path: '/blog', label: 'Blog' },
] as const;
