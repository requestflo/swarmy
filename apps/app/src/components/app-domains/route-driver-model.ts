/**
 * Which front door can carry one address — pure. The same rule as
 * `routeChannel` (@swarmy/ingress): the app's declared exposure
 * (`swarmy.expose`) wins; then the route's own driver can only move the
 * address onto the org's Cloudflare Tunnel or leave it to you. Only drivers
 * the org's edge can run are offered: the tunnel needs one connected.
 */

/** The route's `driver`: null = the org's front door. */
export type RouteDriverValue = null | 'cloudflared' | 'none';

export interface RouteDriverChoice {
  value: RouteDriverValue;
  label: string;
  say: string;
  /** False when the org can't run it right now (shown only because the route already uses it). */
  available: boolean;
}

export interface RouteDriverPlan {
  /** Set when the app's declared exposure decides for every address (no picker). */
  locked: string | null;
  choices: RouteDriverChoice[];
  current: RouteDriverValue;
}

export interface RouteDriverInput {
  orgDriver: string;
  tunnelConfigured: boolean;
  expose?: string | null;
  routeDriver?: string | null;
}

const ORG: Record<string, { label: string; say: string }> = {
  caddy: { label: 'The front door', say: 'Visits reach your servers on ports 80 and 443, with HTTPS set up for you.' },
  cloudflared: { label: 'Your Cloudflare Tunnel', say: 'Visits come through Cloudflare; your servers need no public address.' },
  none: { label: 'Your own proxy', say: 'swarmy writes no routing; the proxy you run serves every address.' },
};

const LOCKED: Record<string, string> = {
  private: 'Only your private network reaches this app, so no front door serves its addresses.',
  mesh: 'Only your private network reaches this app, so no front door serves its addresses.',
  tunnel: 'This app only takes visits through your Cloudflare Tunnel, so every address goes through it.',
};

export function routeDriverPlan(i: RouteDriverInput): RouteDriverPlan {
  const raw = i.routeDriver === 'cloudflared' || i.routeDriver === 'none' ? i.routeDriver : null;
  // Asking for the org's own driver is the same as not asking.
  const current: RouteDriverValue = raw === i.orgDriver ? null : raw;
  const locked = i.expose ? LOCKED[i.expose] ?? null : null;
  if (locked) return { locked, choices: [], current };

  const org = ORG[i.orgDriver] ?? ORG.caddy!;
  const choices: RouteDriverChoice[] = [{ value: null, label: org.label, say: org.say, available: true }];
  if (i.orgDriver !== 'cloudflared' && (i.tunnelConfigured || current === 'cloudflared')) {
    choices.push({
      value: 'cloudflared',
      label: 'Through your Cloudflare Tunnel',
      say: i.tunnelConfigured
        ? 'Cloudflare carries visits to this address; it leaves the public front door.'
        : 'No tunnel is connected, so this address can’t be reached until you connect one on Front door.',
      available: i.tunnelConfigured,
    });
  }
  if (i.orgDriver !== 'none') {
    choices.push({
      value: 'none',
      label: 'Leave it to me',
      say: 'swarmy stops serving this address; point your own proxy at the app.',
      available: true,
    });
  }
  return { locked: null, choices, current };
}
