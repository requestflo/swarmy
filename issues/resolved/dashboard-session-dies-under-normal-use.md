# The dashboard silently ejects you to `/login` during completely ordinary use — no idle period required, roughly once a minute or sooner

**Status:** Fixed (2026-09) — root cause verified: swarmy used Better Auth's default `better-auth.*`
cookie names, which every other Better Auth app on the same host shares (cookies are scoped by host,
not port, so all `localhost:*` dev servers collide). Cookies are now namespaced `swarmy.*`, and the
dashboard re-checks the session before ejecting anyone. See "Fix applied (2026-09)" below.
**Severity:** Critical — this is not a rare edge case. It reproduced **5 times live** in one testing
segment, from completely ordinary actions (clicking a nav tab, clicking a stack-detail sub-tab, a
plain URL navigation), with no deliberate idle period between reproductions. For a product whose
entire pitch is "seamless, magical, light-touch," randomly losing your place and getting bounced to a
login screen — with Chrome's autofill then suggesting the wrong saved account — is a first-order
usability failure, not a polish issue.

## Symptom

At unpredictable points during normal interactive use — clicking "Infrastructure" in the left nav,
clicking the "Data" tab within a stack detail page, or simply navigating the browser directly to a
URL like `/nodes` — the dashboard immediately redirects to `/login` instead of loading the requested
page. No error message, no "session expired" notice, nothing in the UI indicates why. This happened
4 times in a row within one continuous testing session (never more than a couple of minutes apart,
often within seconds of the previous successful page load), plus a 5th time immediately after a
**fresh, just-completed login** — i.e., this is not "sessions expire after N idle minutes," it is
"sessions can die within moments of being freshly established."

## Root cause

Two things combine to produce this behavior:

**1. A 60-second client-side cookie cache forces frequent live server checks.**

`packages/auth/src/server.ts:153-155`:

```js
session: {
  cookieCache: { enabled: true, maxAge: 60 },
},
```

better-auth's `cookieCache` lets the client trust a locally-cached, signed session cookie for up to
`maxAge` seconds without round-tripping to the server. With `maxAge: 60`, roughly once a minute the
next session check must hit the server for real instead of using the cache. No `expiresIn` /
`updateAge` overrides are set on the `session` block, so the actual DB-backed session should default
to better-auth's standard 7-day expiry — meaning a live check failing this quickly is not expected
default behavior, and points at something invalidating the underlying session server-side well before
its nominal expiry (unconfirmed exact trigger — see "Not yet tested" below).

**2. Every route navigation runs a hard, unconditional redirect-on-empty-session guard.**

`apps/app/src/routes/_authed.tsx:6-15` (this wraps essentially the entire authenticated app — every
nav click, tab click, and direct URL navigation is a route change under `_authed`):

```jsx
beforeLoad: async () => {
  if (isDemo()) return;
  const { data } = await authClient.getSession();
  if (!data?.session) {
    throw redirect({ to: '/login' });
  }
},
```

This calls `authClient.getSession()` fresh on **every navigation**, and the instant it comes back
empty, the user is redirected — no retry, no grace period, no distinction between "genuinely logged
out" and "a transient hiccup in session validation." Combined with the 60-second cookie cache above,
any navigation that happens to land on a "must revalidate" tick, at a moment the server-side check
comes back empty, results in an instant, silent logout with zero warning.

Separately, confirmed via live network-request inspection (`system.dashboardSummary`, which polls in
the background every few seconds) that this same empty-session condition also surfaces as bare `401`
responses to background tRPC polling — but since no 401 interceptor exists anywhere in the tRPC
client setup (`apps/app` — grepped for 401 handling in the trpc client config, found none), the
background poll just fails silently in place; it's only the *next navigation's* `beforeLoad` guard
that actually boots the user, which is why the failure appears to "happen on click" even though the
underlying session had already gone bad moments earlier.

## Compounding usability problem: wrong account autofilled on relogin

Every time this forces a relogin, Chrome's autofill suggests a **stale/wrong** saved test-account
email (observed suggesting `calum+swarmytest@gomacrae.com` even while the active, intended session
was for `calum+swarmytest3@gomacrae.com`). This is a browser-autofill quirk, not swarmy's bug, but it
compounds the severity in practice — a real user hitting this will not only get bounced unexpectedly,
they'll likely also have to fight their own browser's autofill to get back in with the right account,
especially in any household/team setting with more than one swarmy login saved.

## Why this matters

The governing directive for this sweep is explicit: swarmy should feel "magical" and require no
babysitting. A session that can silently die within moments of a fresh login, on totally ordinary
clicks, with no warning and no clear cause, is the opposite of that — and it's disruptive enough to
have interrupted this testing session's own workflow repeatedly (every reproduction cost a full
relogin cycle before testing could resume).

## Suggested fix direction

- Add a 401/empty-session interceptor to the tRPC client that distinguishes "genuinely signed out"
  from "transient revalidation hiccup" — e.g. retry once before redirecting, or only redirect on a
  *confirmed* signed-out state rather than any single empty response.
- Investigate why the live (non-cached) `getSession()` check returns empty well inside the default
  7-day session lifetime — needs direct inspection of the `session` table for this user/org (row
  presence, `expiresAt`, `updatedAt`) at the moment of a reproduced failure, which wasn't reached this
  segment before it was itself interrupted by another instance of the same bug.
  Also worth checking whether repeatedly signing in with multiple different accounts in the same
  browser session (as this testing sweep did — `swarmytest`, `swarmytest2`, `swarmytest3`) triggers
  any single-session-per-user invalidation behavior that a normal single-account user wouldn't hit as
  often — if so, this bug may be less severe for typical usage than these 5 reproductions suggest, but
  that needs to be confirmed, not assumed.
- Consider raising `cookieCache.maxAge` past 60s (or disabling it) if it turns out to just be
  needlessly increasing how often the flaky live check gets a chance to fire, once the underlying
  live-check failure itself is understood.
- At minimum, show a real "your session expired, please sign back in" message instead of a silent,
  contextless redirect — even without fixing the underlying cause, this would turn a confusing failure
  into a legible one.

## 6th reproduction — session died mid-page, with zero navigation

Reproduced again while testing cache provisioning on the `littleworld` stack's Data tab. This
occurrence is new evidence: **no navigation was involved at all.** I loaded `/stacks/littleworld/data`
once, and while simply reading the page and clicking within the already-loaded Caches panel (no route
change), background tRPC polling started 401ing. Captured via `read_network_requests`: the first batched
call on page load (`org.currentOrg,system.dashboardSummary,org.whoami,alerts.overview,...`) returned
`200`, and every single batched call after it — `db.get,inventory.get`, `system.dashboardSummary,cache.list,search.list,vector.list`,
`alerts.overview,incidents.overview`, `vector.pgvector`, `cache.list` — returned `401`, repeatedly, for
the rest of the session (at least 24 consecutive 401s observed). Clicking the inline "Retry" button next
to the resulting "UNAUTHORIZED" banner did not recover it — it just re-issued the same call and got
another 401.

This rules out "only happens on route-change timing" as the trigger: the underlying session died while
the tab was simply sitting on one page, not navigating. The `beforeLoad` redirect guard (see mechanism
above) hadn't fired yet only because no route change had happened to trigger it — the session was
already dead underneath, silently, before any user-visible symptom appeared. This strengthens the case
that the live-session-check failure is time-based (something server-side invalidating/expiring the
session on a short clock) rather than purely a race tied to navigation.

## 7th and 8th reproductions — dying within ~1-2 minutes of a fresh login, back to back

Two more reproductions immediately following the 6th (all within the same continuous testing
segment). The 7th: a "Resilience" score card on a stack page showed `UNAUTHORIZED` while the rest
of the page still rendered normally — session already dead, no user-visible symptom yet — then
the very next sidebar navigation click bounced straight to `/login` (with the same wrong-account
autofill compounding problem recurring, suggesting `calum+swarmytest@gomacrae.com` instead of
the active `calum+swarmytest3@gomacrae.com`). Logged back in successfully. The 8th: within
roughly 1-2 minutes of that fresh login, a plain `navigate()` to `/stacks` bounced straight to
`/login` again, with no interactive session in between beyond a couple of page loads.

This is the sharpest evidence yet: the session is not surviving even a couple of minutes of very
light, intermittent use immediately after a fresh login — not just "occasionally within a testing
session" but "reliably within ~1-2 minutes, repeatedly, back to back." Whatever is invalidating
the live session server-side is on a very short clock (well under the 60s `cookieCache.maxAge`
multiplied by even a couple of revalidation ticks), or something about repeated fresh logins in
the same browser session (three different accounts have now been used across this sweep) is
actively shortening subsequent sessions' effective lifetime.

## 9th reproduction — near-instantaneous, zero interactive time at all

Immediately after the 8th reproduction's relogin: navigated to a guessed-wrong URL (`/deploy`,
404 "Not Found" — not a redirect, so the session was still alive at that point), then on the very
next navigation, to `/stacks`, was bounced straight to `/login`. Total elapsed time between the
two navigations: a few seconds, no clicks, no typing, nothing but two sequential page loads.

This is qualitatively different from the 6th-8th reproductions (which took anywhere from
"mid-page with no navigation" to "1-2 minutes after login"). A gap this short is hard to square
with a purely time-based expiry (even a 60s `cookieCache` tick), and starts to look more
consistent with something keyed to **request count** or **navigation count** rather than wall-clock
time — e.g. every Nth `beforeLoad` check, or every Nth background poll tick, invalidating the
session regardless of how little real time has passed. Not confirmed — would need server-side
session-table/log inspection to pin down, which has not been reached this sweep (see "Not yet
tested" below, unchanged in nature but now higher priority given this evidence).

Given 9 live reproductions now documented across a wide range of timings (zero-navigation,
1-2 minutes, and now single-digit seconds), further live reproductions are not being logged
individually going forward unless they reveal a genuinely new mechanism (e.g. a specific
navigation pattern that reliably triggers or avoids it) — the bug is considered fully proven at
this point, and the remaining open question is purely the server-side "why," not "does this
happen."

## Not yet tested

The exact server-side trigger for the live session check returning empty. Whether this reproduces
with only one account ever logged into the browser (this sweep used three, sequentially, which may or
may not be a contributing factor). Whether it reproduces in a non-dev-server (production build)
deployment, where hot-reload/watch-mode behavior (not yet ruled out as a contributing factor, though
`BETTER_AUTH_SECRET` was confirmed stable across this session so process restarts alone don't explain
it) is not a factor.

## Fix applied (2026-09)

### Verified root cause: cookie-name collision on the host, not a server-side expiry

- **The server never invalidated these sessions.** The local `session` table still holds every
  session from the sweep (32 rows, e.g. 8 `swarmytest3` sessions created 2026-07-11 01:57 → 11:09,
  a few minutes apart). None were deleted, all had `expiresAt` = created + 7 days, and
  `updatedAt == createdAt`. If the browser had sent a valid token cookie, the live DB lookup would
  have found a valid row. So the failure was in the cookie, not in the DB.
- **The server path is stable on its own.** A curl soak (sign in, then `get-session` + a protected
  tRPC call every 6s for about 3 minutes, across three 60s cookie-cache expiries) returned 200 every
  time. The 60s `cookieCache` isn't the cause.
- **Better Auth 1.6.22 `get-session` only returns `null` in two cases**
  (`dist/api/routes/session.mjs:42-43,178-189`): the signed `session_token` cookie is missing or its
  HMAC fails, or the DB row is missing or expired. The row was present, so the cookie was missing
  or signed by a different secret.
- **Something else on the host wrote that cookie.** swarmy set no `advanced.cookiePrefix`, so its
  cookies were named `better-auth.session_token` / `better-auth.session_data`. Browsers scope cookies
  by host and ignore the port. On `localhost` (API :3021, dashboard :3023), every other Better Auth
  dev server shares that one cookie jar. More than ten sibling projects in `~/source` depend on
  `better-auth` with the default prefix, and concurrent agents sign into them in the same Chrome.
  Whenever any of them signs in or refreshes, it overwrites swarmy's token with a value signed by
  its own secret. swarmy's next check that isn't served from the cache fails the HMAC and returns
  `null`. Background tRPC calls start returning 401 at once (this is the zero-navigation 6th
  reproduction), and the next navigation redirects to /login. The timing depends on other apps'
  activity, not on swarmy's clock. That explains why some sessions died within seconds and others
  after a few minutes.
- **Reproduced live.** Signed into swarmy (`get-session` returned the session and
  `system.dashboardSummary` returned 200). Then signed into a throwaway Better Auth app on
  `localhost:3999` (its own secret, default prefix) with the same cookie jar. Right after that,
  swarmy's `get-session` returned `null` and `system.dashboardSummary` returned **401**, while the
  swarmy session row was still valid in the DB. With the fix the same sequence leaves swarmy's
  session intact: the two apps now keep separate `better-auth.session_token` and
  `swarmy.session_token` cookies.
- The "wrong account autofilled" note and the multiple swarmy test accounts were not factors. The
  issue happens even with a single swarmy account.

### Changes

- `packages/auth/src/server.ts` (`advanced.cookiePrefix`, about line 157): cookies are now
  `swarmy.session_token` / `swarmy.session_data` (`__Secure-swarmy.*` on https). The prefix can be
  overridden with `SWARMY_AUTH_COOKIE_PREFIX` when several swarmy controllers share a host. One-time
  effect: existing `better-auth.*` cookies are ignored, so every user signs in once after upgrading.
- `packages/auth/src/server.test.ts` (new): regression test that the session cookie names use the
  `swarmy` prefix.
- `apps/app/src/integrations/trpc-auth.ts` (new):
  - `hasLiveSession()` checks the session, then retries once with `disableCookieCache: true`.
  - `unauthorizedLink()`: on an `UNAUTHORIZED` response it runs one shared session re-check for the
    whole burst. If the session is live, it replays the operation once. If not, it hard-redirects to
    `/login?redirect=<current path>`, so background polls no longer keep returning 401s in place.
- `apps/app/src/integrations/trpc.tsx`: `unauthorizedLink()` is added ahead of `splitLink` (not in
  demo mode).
- `apps/app/src/routes/_authed.tsx`: `beforeLoad` uses `hasLiveSession()` (one retry that bypasses
  the cache) and redirects with `search.redirect`.
- `apps/app/src/routes/login.tsx`: accepts a same-origin `redirect` search param and returns the
  user there after sign-in.

### Verification

- `bun test` in `packages/auth`: 9 pass. `tsc --noEmit` is clean for `@swarmy/auth` and
  `@swarmy/app`, and `vite build` for `@swarmy/app` is clean.
- Link behaviour was checked with a scripted harness:
  - One transient 401 while the session is live: re-check, replay, and the data comes back.
  - Persistent 401 while the session is live: one retry, then the error surfaces, with no redirect
    and no loop.
  - Session dead: `get-session` is called and then retried with `?disableCookieCache=true`, followed
    by one redirect to `/login?redirect=%2Fstacks%3Fa%3D1`.

### Related, not fixed here

`org.switchOrg` calls `auth.api.setActiveOrganization` server-side, and the Set-Cookie headers that
call produces are dropped. The cached `session_data` cookie therefore keeps the old
`activeOrganizationId` for up to 60s after a switch. This doesn't eject users, but the org switch can
appear not to take effect for up to a minute.

