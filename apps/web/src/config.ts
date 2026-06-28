/**
 * Where the swarmy dashboard lives. Configurable per deploy via VITE_APP_URL
 * (e.g. https://app.swarmy.dev); falls back to the local dev dashboard on :3003.
 */
export const APP_URL: string = import.meta.env.VITE_APP_URL ?? 'http://localhost:3003';

/**
 * The dashboard's zero-backend demo mode — `?demo=1` boots the full, interactive
 * dashboard with no backend/DB/auth, so visitors can play before they sign up.
 */
export const DEMO_URL: string = `${APP_URL.replace(/\/$/, '')}/?demo=1`;
