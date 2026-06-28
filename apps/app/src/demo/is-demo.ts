/**
 * Demo mode — the dashboard runs with zero backend (no DB, no auth, no agents),
 * driven entirely by an in-memory store. Used for the public "play with it" demo.
 *
 * Detection must resolve at module-load time (the tRPC client is created once,
 * up front), so it keys off things present on the very first page load:
 *   - build flag VITE_SWARMY_DEMO=1 (a dedicated demo deployment), or
 *   - `?demo` / `?demo=1` in the URL (the marketing "Try live demo" link), or
 *   - a sticky localStorage flag set the first time either of the above is seen.
 */
const KEY = 'swarmy-demo';

export function isDemo(): boolean {
  if (import.meta.env.VITE_SWARMY_DEMO === '1') return true;
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('demo')) {
      window.localStorage.setItem(KEY, '1');
      return true;
    }
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Leave the demo (clears the sticky flag) — used by the "Get swarmy" CTA. */
export function exitDemo(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
