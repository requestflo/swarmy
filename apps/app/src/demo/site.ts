/**
 * The hosted public demo (`VITE_SWARMY_DEMO=1`, apps/app/demo.Dockerfile).
 *
 * DEMO_BUILD is a compile-time constant: a demo build never has a controller
 * behind it, so every controller-bound surface (auth, terminal, websockets)
 * swaps in a "this is a demo" notice and the network guard refuses the rest.
 */
export const DEMO_BUILD: boolean = import.meta.env.VITE_SWARMY_DEMO === '1';

/** The marketing site the demo links back to (VITE_SWARMY_SITE_URL, baked in at build). */
export const DEMO_SITE_URL: string = (import.meta.env.VITE_SWARMY_SITE_URL || 'https://swarmy.dev').replace(/\/$/, '');

/** Where "Install swarmy" goes: the Getting Started install guide on the marketing site. */
export const DEMO_INSTALL_URL = `${DEMO_SITE_URL}/docs/getting-started/install`;
