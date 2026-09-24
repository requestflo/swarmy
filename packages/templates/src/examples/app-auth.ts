/**
 * Auth for your apps, with no auth code in the app (dev-platform §2) — the two
 * flavours as ready-to-copy swarmy.yaml examples (the "New app from Git"
 * starter and the docs read these; `app-auth.test.ts` keeps them valid).
 */

/**
 * Protect my app: a plain app, then Access → "Require login" in the
 * dashboard. swarmy's edge signs people in with swarmy's own login (SSO,
 * social, magic link) and forwards X-Swarmy-User / -Email / -Groups plus a
 * signed X-Swarmy-Jwt. whoami echoes the request headers, so you can see them.
 */
export const PROTECT_MY_APP_EXAMPLE = `version: 1
app: internal-tools
services:
  web:
    image: traefik/whoami:v1.10.3
    port: 80
    memory: 32mb
    domains: [tools.example.com]
`;

/**
 * End-user auth: your app's own customers sign in. swarmy runs a Better Auth
 * service at /auth on the app's domain (users in the app's Postgres here) and
 * the app calls getSession(req) from @swarmy/app-auth. Create the Docker
 * secrets auth-github-client-id / auth-github-client-secret and
 * auth-google-client-id / auth-google-client-secret first (Secrets page), and
 * register https://shop.example.com/auth/callback/<provider> with each provider.
 */
export const END_USER_AUTH_EXAMPLE = `version: 1
app: shop
services:
  web:
    build: .
    port: 3000
    domains: [shop.example.com]
    env:
      DATABASE_URL: \${{ db.url }}
resources:
  db: postgres
auth:
  providers: [github, google]
  email: magic-link
  allowedDomains: []
`;

/** The app side of END_USER_AUTH_EXAMPLE (Bun / any Fetch-style server). */
export const END_USER_AUTH_APP_SNIPPET = `import { getSession } from '@swarmy/app-auth';

Bun.serve({
  port: 3000,
  async fetch(req) {
    const session = await getSession(req); // proxy JWT or the app's own auth service
    if (!session) return Response.redirect('/auth/login?callbackURL=/', 302);
    return new Response(\`Hello \${session.user.email ?? session.user.id}\`);
  },
});
`;
