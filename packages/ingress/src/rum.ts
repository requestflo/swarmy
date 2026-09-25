import { z } from 'zod';

/**
 * Real-user monitoring at the edge (dev-platform epic §5 session replay + §7
 * web analytics). A route carrying `rum` has swarmy's RUM tag injected into
 * its HTML documents by the edge (the `swarmy_rum` Caddy module in
 * docker/caddy-swarmy/rum), so the app itself is never modified.
 *
 * Everything the browser talks to is FIRST-PARTY: the tag loads
 * `/_swarmy/rum.js` and posts to `/_swarmy/rum` on the app's own domain; the
 * edge maps `/_swarmy/*` onto the controller's `/_rum/*`. No third-party
 * origin, no third-party cookie.
 *
 * `token` is the controller-signed app token (org + stack + mode + retention),
 * so the ingest endpoint knows which app a beacon belongs to without trusting
 * anything the browser claims.
 */

/** Path prefix on the APP's domain that carries the RUM script + ingest. */
export const RUM_PATH_PREFIX = '/_swarmy';
/** Controller path the app-domain prefix is rewritten onto. */
export const RUM_CONTROLLER_PREFIX = '/_rum';
/** The script the tag loads (same-origin). */
export const RUM_SCRIPT_PATH = `${RUM_PATH_PREFIX}/rum.js`;
/**
 * Request header rum.js puts on same-origin fetch/XHR in identified mode
 * (never in privacy mode). Deliberately NOT `X-Swarmy-*`: that namespace is
 * reserved for identity headers only the controller may set (app auth strips
 * every client-sent one).
 */
export const RUM_SESSION_HEADER = 'Swarmy-Session';
/** Span attribute the edge span carries the session id under. */
export const RUM_SESSION_SPAN_ATTRIBUTE = 'swarmy.session_id';

export const RUM_MODES = ['analytics', 'identified'] as const;
export type RumMode = (typeof RUM_MODES)[number];
export const RUM_CONSENT_MODES = ['none', 'hook', 'cmp'] as const;
export type RumConsentMode = (typeof RUM_CONSENT_MODES)[number];

export const RouteRumSchema = z.object({
  /** Controller dial target `host:port`, reachable from the edge (the activator's upstream). */
  upstream: z.string().min(1),
  /** Controller-signed app token — base64url segments joined by dots. */
  token: z.string().regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'token must be base64url segments'),
  /** `analytics` = cookieless aggregate only (default); `identified` = sessions, replay, user. */
  mode: z.enum(RUM_MODES).default('analytics'),
  /** Share of identified sessions recorded for replay (0 = no replay). */
  replaySampleRate: z.number().min(0).max(1).default(0),
  /** Consent gate for identified mode: none, `window.swarmyConsent(true)`, or the page's CMP. */
  consent: z.enum(RUM_CONSENT_MODES).default('none'),
  /** Mask ALL text in replays (inputs are always masked). */
  maskAllText: z.boolean().default(false),
  /** CSS selectors never recorded (blocked, drawn as a grey box). */
  blockSelectors: z
    .array(z.string().min(1).max(200).regex(/^[^<>"`{}\\\n]+$/, 'selector must not contain < > " ` { } \\ or newlines'))
    .max(20)
    .default([]),
  /** How the edge treats a page CSP: `rewrite` admits the tag, `skip` leaves CSP pages alone. */
  csp: z.enum(['rewrite', 'skip']).default('rewrite'),
});
export type RouteRum = z.infer<typeof RouteRumSchema>;

/** Is a route's RUM identified (session ids, replay, user id)? */
export function rumIdentified(r: RouteRum | undefined): boolean {
  return r?.mode === 'identified';
}

/**
 * Caddy global `order` line for the swarmy_rum directive. Emitted BEFORE the
 * cache order line so the injector wraps the cache (each response gets its
 * own nonce; a cached page never pins one).
 */
export const CADDY_RUM_ORDER = '  order swarmy_rum before rewrite';

/**
 * Host-level handle mapping `/_swarmy/*` onto the controller. Placed before
 * the route handles so no app path can shadow it.
 */
export function caddyRumHandle(r: RouteRum): string[] {
  return [
    '  # swarmy RUM (analytics / replay): first-party script + ingest',
    `  handle_path ${RUM_PATH_PREFIX}/* {`,
    `    rewrite * ${RUM_CONTROLLER_PREFIX}{uri}`,
    `    reverse_proxy ${r.upstream}`,
    '  }',
    ...caddyReplayFontCors(r),
  ];
}

/**
 * Session replays render in the swarmy dashboard, a different origin, and
 * browsers CORS-gate web fonts (and only fonts), so every replay logged
 * "blocked by CORS policy" and fell back to system fonts (QA-057). On routes
 * that record replays, font files get `Access-Control-Allow-Origin: *`, but
 * only when the app sets none itself (`?`). Fonts are public, credential-free
 * assets. PURE.
 */
export function caddyReplayFontCors(r: RouteRum): string[] {
  if (r.mode !== 'identified' || !(r.replaySampleRate > 0)) return [];
  return [
    '  # Replays render in the swarmy dashboard: let it load this app\'s fonts (CORS-gated).',
    '  @swarmy_replay_fonts path *.woff2 *.woff *.ttf *.otf *.eot',
    '  header @swarmy_replay_fonts ?Access-Control-Allow-Origin *',
  ];
}

/**
 * The `swarmy_rum` directive for one route. `userHeader` renders `data-uid`
 * from the app-auth identity header — only on login-protected routes, where
 * the edge strips any client-sent copy first (a spoofable header would let a
 * visitor label their own session as someone else).
 */
export function caddyRumDirective(
  r: RouteRum,
  opts: { userHeader?: string; serverTiming: boolean },
): string[] {
  const out = ['swarmy_rum {', `  attr data-app ${r.token}`, `  attr data-mode ${r.mode}`];
  if (r.mode === 'identified') {
    if (r.replaySampleRate > 0) out.push(`  attr data-replay ${formatRate(r.replaySampleRate)}`);
    if (r.consent !== 'none') out.push(`  attr data-consent ${r.consent}`);
    if (r.maskAllText) out.push('  attr data-mask all');
    if (r.blockSelectors.length > 0) out.push(`  attr data-block "${r.blockSelectors.join(',')}"`);
    if (opts.userHeader) out.push(`  attr data-uid {http.request.header.${opts.userHeader}}`);
  }
  if (r.csp === 'skip') out.push('  csp skip');
  if (opts.serverTiming) out.push('  server_timing');
  out.push('}');
  return out;
}

/** Span attribute lines for the edge `tracing` block (identified mode only). */
export function caddyRumSpanAttributes(): string[] {
  return [
    '    span_attributes {',
    `      ${RUM_SESSION_SPAN_ATTRIBUTE} {http.request.header.${RUM_SESSION_HEADER}}`,
    '    }',
  ];
}

/** Stable, short decimal for a 0..1 rate (no float noise in goldens). */
function formatRate(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}
