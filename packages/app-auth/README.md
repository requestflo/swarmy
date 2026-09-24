# @swarmy/app-auth

Sessions for apps behind swarmy auth, with no auth code of your own.

```ts
import { getSession } from '@swarmy/app-auth';

const session = await getSession(req); // Fetch Request, Node IncomingMessage, or { headers }
if (!session) return new Response('sign in first', { status: 401 });
session.user; // { id, email, name, groups }
```

- **Protect my app** (the "Require login" toggle): the swarmy edge signs people in and
  forwards a short-lived JWT in `X-Swarmy-Jwt`. `getSession` verifies it against the
  controller's JWKS (`SWARMY_JWKS_URL`, default the in-swarm controller) and checks it is
  addressed to this app's host.
- **End-user auth** (`auth:` in `swarmy.yaml`): the app's own Better Auth service runs at
  `/auth/*` on your domain. `getSession` verifies a bearer JWT, or exchanges the browser
  session cookie at the service (`SWARMY_AUTH_URL`, injected by swarmy) for one.

Browser helpers: `import { createAuthClient } from '@swarmy/app-auth/client'`.
