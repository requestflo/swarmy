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
 * Where the swarmy dashboard lives. Configurable per deploy via VITE_APP_URL
 * (e.g. https://app.swarmy.dev); falls back to the local dev dashboard on :3023.
 */
export const APP_URL: string = import.meta.env.VITE_APP_URL ?? 'http://localhost:3023';

/**
 * The dashboard's zero-backend demo mode — `?demo=1` boots the full, interactive
 * dashboard with no backend/DB/auth, so visitors can play before they sign up.
 * The dashboard at APP_URL must be built with VITE_SWARMY_DEMO_LINKS=1 — a real
 * controller's dashboard ignores `?demo` on purpose.
 */
export const DEMO_URL: string = `${APP_URL.replace(/\/$/, '')}/?demo=1`;

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
