# Epic: Better Auth providers (toggle-on) + Organizations with ABAC

> Status: plan / implementation-ready. Targets the existing swarmy scaffold (Bun + Turborepo, tRPC v11/Hono, Prisma 7/Postgres, Better Auth + organization plugin, `@swarmy/auth` server/client, the `protectedProcedure → orgProcedure → adminProcedure` chain, and the `AuditLog` model). Do not redesign the scaffold; this epic *extends* the auth/authorization layer that already exists.

## Problem

Two problems, one epic, because they share the same surface (who you are, what you may do).

**1. Auth providers must be opt-in from the UI, not the env file.** Today `@swarmy/auth/server.ts` is a single module-level `betterAuth({...})` with `emailAndPassword` hardcoded and only the `organization()` plugin. Adding GitHub/Google/GitLab/Microsoft, passkeys, magic link, or enterprise SSO (OIDC/SAML) currently means editing source + redeploying, and stuffing client secrets into `.env`. That violates "anyone can just deploy — it has to be that simple": a self-hoster should land in the dashboard, flip on "Sign in with GitHub", paste a client id/secret, and be done — no rebuild, no restart, no YAML. The hard parts: (a) Better Auth wants its social/SSO plugins declared at construction time, but we want them toggled at *runtime*; (b) secrets (OAuth client secrets, SAML signing keys) must be stored encrypted, never in env, and be org-scoped for the hosted multi-tenant story; (c) enterprise SSO (per-org OIDC/SAML, domain-based routing) is a different lifecycle than instance-wide social login.

**2. Roles are not enough.** The org plugin gives us `owner | admin | member` as a flat string on `Member`, and the tRPC chain enforces exactly three tiers (`adminProcedure` = "not member"). Real teams need finer control that role tiers can't express without exploding into dozens of roles: "the on-call engineer may `restart` any service but may not `remove` nodes", "contractors may act only on stacks labelled `env=staging`", "this service is owned by team-payments; only they may scale it", "deploys are blocked outside a change window". That is **attribute-based access control (ABAC)**: decisions are a function of *subject* attributes, *resource* attributes, *action*, and *context* — not a role lookup. We need a policy model + an evaluation engine that layers *over* the existing role system (roles become one attribute among many, and remain the zero-config default), per-resource (node/stack/service) scoping, and a single tRPC middleware seam so every procedure is checked uniformly and audited.

These are one epic because the policy engine's "subject" is exactly the identity Better Auth produces, and because both must stay invisible until opted into.

## Recommended approach

### Auth providers: **a runtime-built Better Auth instance + a DB-backed `AuthProviderConfig` store + an encrypted secret column; SSO via the official `@better-auth/sso` plugin (OIDC + SAML), passkey + magic-link + generic social via first-party plugins.**

Better Auth is already chosen and correct — it has first-party plugins for every provider class in scope (built-in social providers, `passkey`, `magicLink`, and `sso` for OIDC/SAML), the organization plugin we already use, and a Prisma adapter against our schema. We do **not** swap auth libraries. The work is making it *dynamic*.

**The core move: stop exporting a frozen `auth` singleton; export a builder + a cached, rebuildable instance.**

- New `buildAuth(config: ResolvedAuthConfig): Auth` in `@swarmy/auth` that takes a plain config object (which providers are on, their public params, and *decrypted* secrets) and returns a configured `betterAuth(...)`. All the static bits (Prisma adapter, secret, baseURL, trustedOrigins, session, organization plugin, emailAndPassword) stay; the social `socialProviders`, `passkey()`, `magicLink()`, and `sso()` plugins are added conditionally from `config`.
- `ResolvedAuthConfig` is assembled by a `loadAuthConfig(db)` function that reads the new `AuthProviderConfig` rows, decrypts secrets, and merges with env fallbacks (so a power user *can* still seed GitHub via env on first boot — env is a fallback, the DB is the source of truth).
- A small `AuthRegistry` holds the current `auth` instance behind `getAuth()`. On config change (a tRPC mutation), it calls `rebuild()` → `buildAuth(loadAuthConfig(db))` and atomically swaps the cached instance. apps/api's `auth.handler` and tRPC `createContext` call `getAuth()` instead of importing the constant. **No process restart** to enable a provider.

Why rebuild-and-swap rather than per-request construction: `betterAuth()` is cheap to construct but not free (it wires plugins/routes), and Better Auth's handler expects a stable instance for its route table. Rebuilding only on config change (rare, admin-initiated) is the right cost. Why not multiple Better Auth instances (one per org): the social/passkey/magic-link providers are **instance-wide** (one GitHub OAuth app for the whole controller is the common self-host case) and the org plugin already multi-tenants users; only *enterprise SSO* is genuinely per-org, and the `sso` plugin handles per-org/per-domain provider registration *inside one instance* (it stores SSO providers as rows and routes by org/email-domain). So: **one instance, instance-wide social toggles, per-org SSO rows.** Clean.

**Provider matrix and how each is enabled:**

| Provider class | Better Auth mechanism | Scope | Secrets |
|---|---|---|---|
| GitHub / Google / GitLab / Microsoft / Discord / Apple / etc. | `socialProviders: { github: { clientId, clientSecret } }` | instance-wide | clientSecret (encrypted) |
| Magic link (email) | `magicLink()` plugin + `sendMagicLink` | instance-wide | none (uses SMTP/email sender) |
| Passkeys (WebAuthn) | `passkey()` plugin | instance-wide | none |
| Email + password | `emailAndPassword` (already on) | instance-wide | none |
| Enterprise OIDC | `@better-auth/sso` plugin, `registerSSOProvider` (OIDC) | **per-org** | client secret (encrypted) |
| Enterprise SAML | `@better-auth/sso` plugin, SAML config (IdP metadata, SP cert/key) | **per-org** | SP private key (encrypted) |

**Secrets handling — never in env, never plaintext in DB.** Add a tiny `@swarmy/crypto` helper (or a `crypto.ts` in `@swarmy/auth`) doing **AES-256-GCM** envelope encryption with a key derived from a new `SWARMY_SECRET_KEY` env var (the *only* new required secret; documented like `BETTER_AUTH_SECRET`). `AuthProviderConfig.encryptedSecret` stores `iv:tag:ciphertext` (base64). Decryption happens only in `loadAuthConfig`, in-process, never sent to the client. The tRPC read endpoint returns provider *status + public fields* (clientId, enabled, callback URL) but **never** the secret — secret writes are write-only (set, never read back; UI shows "•••• set" / "rotate"). This is the same posture the scaffold already uses for join tokens (hash, never return). Node's built-in `crypto` (Bun-compatible) suffices — no new dependency.

**Callback URL ergonomics (the simplicity win):** the UI computes and *shows* the exact callback/redirect URL to paste into GitHub/Google (`${CONTROLLER_PUBLIC_URL}/api/auth/callback/github`), and validates the secret by doing a dry token exchange where possible. The user copies one URL out, pastes id+secret in, toggles on. Done.

*Alternatives weighed.* (a) **Env-only providers** (the Better Auth default docs path): rejected — fails the UI-config requirement and the multi-tenant hosted story. (b) **A separate IdP (Keycloak/Authentik/Ory) in front:** rejected as the default — it's a heavy stateful service that nukes the one-command promise; we instead *integrate* with such IdPs *as* an SSO provider for users who already run one. (c) **Auth.js/NextAuth:** rejected — we're not Next, Better Auth's org plugin + SSO plugin + Prisma adapter already fit our stack and schema.

### ABAC: **Cedar-style policies stored in DB, evaluated by an embedded engine, exposed through one `abacProcedure` tRPC middleware; roles become a derived attribute, not the gate.**

The decision model is **PARC**: **P**rincipal (subject) / **A**ction / **R**esource / **C**ontext. A *policy* is `effect (permit|forbid) when (action ∈ A) and (principal matches …) and (resource matches …) and (context matches …)`. We evaluate the set of an org's policies against a request and get **permit/deny + the matching policy id** (for audit/debug).

**Engine choice: Cedar (`@cedar-policy/cedar-wasm`), with a hand-rolled fallback only if Cedar's Bun/WASM ergonomics disappoint; CEL as the runner-up.**

Why Cedar:
- It is *purpose-built* for ABAC/ReBAC authorization (AWS's policy language behind Verified Permissions), with **explicit permit/forbid, forbid-wins semantics**, typed entities, and a `context` record — exactly PARC. We don't reinvent evaluation order or the deny-overrides rule.
- Policies are **human-readable** (`permit(principal, action == Action::"service.restart", resource) when { resource.labels has "env" && resource.labels["env"] == "staging" };`) — good for the UI to render/diff and for users to reason about, and good for our audit trail ("denied by policy P-7").
- A **schema** (entity/action types) gives validation *before* a policy is saved — we reject incoherent policies at write time, which keeps the runtime from silently mis-deciding.
- It compiles to WASM and runs in-process under Bun — **zero new service**, sub-millisecond decisions, no network in the auth hot path. Policies are loaded from DB and cached per-org with invalidation on write.
- ReBAC ("team-payments owns this service") is expressible via entity *parents*/groups in the same model — so we get the Zanzibar-lite "owner/group" relationships *and* attribute rules in one engine, instead of bolting on a separate relationship store.

Why not the alternatives:
- **Hand-rolled JSON predicate evaluator (`{subject, action, resource, context}` matchers):** tempting for zero-dependency simplicity and we keep it as the *fallback* shape, but it drifts into a half-baked policy language (no validation, ad-hoc precedence, no forbid-wins) the moment requirements grow. Cedar gives us correctness for free.
- **CEL (`cel-js`/Google CEL):** great expression language, but it's an *expression* evaluator, not an authorization *system* — we'd have to invent permit/forbid composition, precedence, and entity relationships on top. Runner-up if Cedar-WASM proves painful under Bun.
- **OPA/Rego as a sidecar:** rejected as default — another service, network hop in the auth path, and Rego is a steeper learning curve than Cedar for the policies our users write. (An OPA *export* could be a later enterprise integration, not the engine.)
- **Full Zanzibar (SpiceDB/OpenFGA):** overkill and a heavy stateful dependency; our scale is "an org's nodes/stacks/services," not Google Drive. Cedar's entity-parent ReBAC covers the relationship needs without a separate graph DB.

**How ABAC layers over the existing role system (and stays zero-config):**

- **Roles are an attribute, not the gate.** The principal entity carries `roles: ["owner"]` (from `Member.role`), org id, user id, and `attributes` (a JSON bag — team, employment type, etc.). The *default* policy set, seeded for every org, is literally the current behaviour expressed as Cedar: `owner`/`admin` permit everything; `member` permits read + safe actions; destructive actions (`node.remove`, etc.) require `admin`/`owner`. **An org that never opens the policy UI behaves exactly as today.** ABAC is additive: only when an admin writes a custom policy does behaviour diverge. This is the unopinionated promise — the feature is invisible until used.
- **Two-stage check.** Coarse stage = the existing `orgProcedure` (authenticated + member of active org) stays as the cheap gate. Fine stage = a new `abacProcedure(action, resourceResolver)` that runs *after* membership is established, builds the PARC request, evaluates policies, and throws `FORBIDDEN` (with `swarmyCode: 'POLICY_DENIED'` + matching policy id) on deny. `adminProcedure` stays for now as a coarse alias but is reimplemented in terms of the default policy so there is one decision path.
- **Per-resource scoping (node/stack/service).** Resources carry attributes the policies match on: `orgId`, `id`, `type`, `labels` (we already store `labels`/`constraints` JSON on Node/Service; stacks get a labels field), and `owner` (a new optional `ownerTeamId`/`ownerMemberId`). The `resourceResolver` for a procedure loads the target row (org-scoped, as services already do) and maps it to a Cedar resource entity. Org-level data isolation (the existing `where: { orgId }`) is unchanged and remains the hard tenant boundary — ABAC operates *within* an org, never across.

## Architecture & integration

### `@swarmy/auth` (extend, don't replace)
- **`buildAuth(config)`** + **`loadAuthConfig(db)`** + an **`AuthRegistry`** (`getAuth()` / `rebuild()`), replacing the frozen `export const auth`. `server.ts` keeps the static config; the dynamic plugins (`socialProviders`, `passkey()`, `magicLink()`, `sso()`) are assembled from `config`.
- Add deps: `@better-auth/sso`; passkey + magicLink ship in `better-auth/plugins`.
- **`crypto.ts`**: `encryptSecret(plaintext)` / `decryptSecret(blob)` (AES-256-GCM, key from `SWARMY_SECRET_KEY`).
- **`client.ts`**: add `passkeyClient()`, `magicLinkClient()`, `ssoClient()` plugins so the dashboard can drive enrollment/sign-in.
- A `sendMagicLink`/`sendVerification` hook wired to the platform email sender (shared with invitations; SMTP/Resend configured the same DB-config way).

### `@swarmy/db` (new models)
```prisma
// Instance-wide social/passkey/magic-link toggles + per-org SSO + ABAC policies.

model AuthProviderConfig {            // social + magic-link + passkey toggles (instance-wide; orgId null)
  id              String   @id @default(cuid())
  orgId           String?            // null = instance-wide; set = future per-org override
  type            String             // "github" | "google" | "gitlab" | "microsoft" | "passkey" | "magic_link" | ...
  enabled         Boolean  @default(false)
  clientId        String?
  encryptedSecret String?  @db.Text  // AES-256-GCM iv:tag:ciphertext; never returned to client
  scopes          Json     @default("[]")
  settings        Json     @default("{}")   // tenant id (microsoft), allowedDomains, etc.
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@unique([orgId, type])
  @@map("auth_provider_config")
}

model SsoProvider {                   // per-org enterprise OIDC/SAML (mirrors @better-auth/sso storage)
  id              String   @id @default(cuid())
  orgId           String
  protocol        String             // "oidc" | "saml"
  providerId      String   @unique   // slug used in /sso/{providerId} routes
  domain          String?            // email-domain routing (acme.com -> this provider)
  issuer          String?
  clientId        String?
  encryptedSecret String?  @db.Text  // OIDC client secret / SAML SP private key
  metadata        Json     @default("{}")   // OIDC discovery / SAML IdP metadata, SP cert
  mapping         Json     @default("{}")   // claim -> user/member-attribute mapping
  enabled         Boolean  @default(true)
  createdAt       DateTime @default(now())
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@index([orgId]) @@index([domain])
  @@map("sso_provider")
}

model Policy {                        // an ABAC policy (Cedar source + parsed cache)
  id          String   @id @default(cuid())
  orgId       String
  name        String
  description String?
  effect      String             // "permit" | "forbid"  (denormalized for listing/filter)
  source      String   @db.Text  // Cedar policy text (source of truth)
  priority    Int      @default(0)
  enabled     Boolean  @default(true)
  isdefault   Boolean  @default(false)   // seeded role-equivalent policies; protected from deletion
  createdById String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@index([orgId, enabled])
  @@map("policy")
}

model ResourceGrant {                 // optional explicit ReBAC edges (team/member -> resource ownership)
  id           String   @id @default(cuid())
  orgId        String
  principalType String            // "member" | "team"
  principalId  String
  resourceType String            // "node" | "stack" | "service"
  resourceId   String
  relation     String            // "owner" | "operator" | "viewer"
  createdAt    DateTime @default(now())
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([principalType, principalId, resourceType, resourceId, relation])
  @@index([orgId, resourceType, resourceId])
  @@map("resource_grant")
}

model Team {                          // optional sub-org grouping for ABAC subject attrs / ownership
  id        String   @id @default(cuid())
  orgId     String
  name      String
  createdAt DateTime @default(now())
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  members TeamMember[]
  @@unique([orgId, name]) @@map("team")
}
model TeamMember {
  id       String @id @default(cuid())
  teamId   String
  memberId String
  team   Team   @relation(fields: [teamId], references: [id], onDelete: Cascade)
  @@unique([teamId, memberId]) @@map("team_member")
}
```
Also: add `attributes Json @default("{}")` to `Member` (subject attribute bag), `labels Json @default("{}")` + optional `ownerTeamId`/`ownerMemberId` to `Stack` (Node/Service already have `labels`); both feed the resource entity. (Better Auth's `sso` plugin may want its own table shape — align `SsoProvider` to whatever the plugin's adapter schema expects, or let the plugin own its table and keep `SsoProvider` as our admin-facing projection.)

### `@swarmy/abac` (new package — the engine, framework-agnostic)
- **`PolicyEngine`**: loads `Policy.source` for an org, compiles via `cedar-wasm`, validates against a **swarmy Cedar schema** (entity types `User`, `Org`, `Team`; resource types `Node`/`Stack`/`Service`/`Org`/`Setting`; action set `node.read|node.remove|node.drain|service.deploy|service.scale|service.restart|service.remove|stack.*|ingress.*|token.*|policy.*|member.*|...`). Per-org compiled-policy cache with `invalidate(orgId)`.
- **`evaluate({ principal, action, resource, context }) → { decision, reasons, policyId }`** — pure, sync, sub-ms.
- **`PrincipalBuilder`** maps `(user, member, teams, attributes)` → Cedar principal entity (with group parents for ReBAC).
- **`ResourceBuilder`** maps a db row → Cedar resource entity (id, type, labels, owner edges from `ResourceGrant`).
- **`DEFAULT_POLICIES`**: the seeded Cedar text reproducing today's `owner/admin/member` semantics; written on org create.
- **Context** includes request time (change-window policies), source IP/user-agent (already on `Session`), and a `dryRun` flag.

### `@swarmy/trpc` (the enforcement seam)
- **`abacProcedure(action, resolveResource?)`** factory built on `orgProcedure`. It: builds principal from ctx (membership + teams + attributes, cached per request), resolves the resource (org-scoped load via a resolver, or `null` for collection/instance actions), evaluates, and on deny throws `FORBIDDEN` with `swarmyCode: 'POLICY_DENIED'` and the policy id in `cause`. On permit, augments ctx with `{ authz: { decision, policyId } }` for downstream audit.
- Add **`POLICY_DENIED`** to `SwarmyCode` in `errors.ts` + a `policyDenied(action, policyId)` helper.
- **Wire existing procedures through it incrementally:** e.g. `nodes.remove` → `abacProcedure('node.remove', resolveNode)`, `nodes.drain` → `abacProcedure('node.drain', resolveNode)`, `services.scale/restart/remove`, `stacks.*`, `ingress.*`, `nodes.generateJoinToken` → `token.create`. `orgProcedure` stays the coarse read gate; reads can also pass through `abacProcedure('*.read')` where row-level filtering matters (list endpoints apply policy as a *filter*, not just a gate — see Risks).
- **New routers:**
  - `auth` (admin): `listProviders`, `setProvider` (toggle + secret, write-only secret, triggers `AuthRegistry.rebuild()`), `getCallbackUrl`, `testProvider`.
  - `sso` (admin): `listSsoProviders`, `upsertSsoProvider` (OIDC/SAML), `delete`, returns IdP-facing metadata (ACS URL, entity id, SP cert).
  - `policies` (admin/`policy.*`-gated): `list`, `get`, `create`, `update`, `delete` (protected if `isdefault`), `validate` (compile-only, no save), `simulate` (run a PARC request against current policies → permit/deny + matching policy, the "why can't X do Y?" debugger), `listActions`/`schema` (for the UI builder).
  - `teams` / `grants` (admin): CRUD for `Team`/`TeamMember`/`ResourceGrant`.
- **`audit.ts` helper (finally use the `AuditLog` model — it has zero writers today):** `writeAudit(ctx, { action, targetType, targetId, metadata })`. The `abacProcedure` calls it on every *deny* (security signal) and every *mutation permit* (records `policyId`, decision). This closes the "everything audited" architecture principle for the authz layer.

### `apps/api` (host wiring)
- Replace `import { auth }` with `getAuth()` from the registry in **`index.ts`** (`auth.handler` route) and **`trpc.ts`** (`createContext`). `loadAuthConfig` runs at boot; `setProvider`/`upsertSsoProvider` mutations call `rebuild()`.
- The SSO callback/ACS routes are served by Better Auth's `sso` plugin under the existing `/api/auth/*` mount — no new Hono route needed beyond what the plugin registers.

### `apps/app` (UI surfaces)
- **Settings → Authentication:** a card grid of providers (GitHub/Google/GitLab/Microsoft/Discord/Apple/passkey/magic-link), each a toggle + "Configure" sheet showing the **copyable callback URL**, client id, write-only secret, scopes. Save → live (rebuild) with a toast. Passkey card → "Register a passkey" for the current user.
- **Settings → Enterprise SSO:** per-org OIDC/SAML setup wizard (paste discovery URL or upload IdP metadata XML; we show ACS/entityID/SP cert to paste into the IdP), domain-routing field.
- **Settings → Access (ABAC):** members table with role + attributes editor; **Teams**; **Resource ownership** (grants); **Policies** list with a Cedar editor (validate-on-type) *and* a no-code rule builder (action picker + subject/resource/context condition rows that generate Cedar under the hood); a **Policy Simulator** ("can `member@acme` `service.restart` `web`?" → permit/deny + which policy + why). Sign-in page reads enabled providers from a public `auth.publicProviders` query to render the right buttons + SSO "Sign in with your company" (email-domain → SSO).

### Protocol / agent
- **No new wire-protocol messages and no agent capabilities.** This epic is entirely controller-side (identity + authorization happen before any command is dispatched). The agent already only acts on commands the controller chose to send; ABAC simply gates whether the controller sends them. This is a deliberate scope boundary that keeps the agent unchanged.

## MVP vs later

**Phase 1 — Providers, the 80%:** runtime-built auth (`buildAuth`/`loadAuthConfig`/`AuthRegistry`), `AuthProviderConfig` model + AES-GCM secrets, `auth` router + Settings→Authentication UI for the common social set (GitHub/Google/GitLab/Microsoft) + magic link + passkeys. Callback-URL helper + secret validation. This alone satisfies "enable the providers I want with a toggle, from the UI."

**Phase 2 — ABAC core:** `@swarmy/abac` with Cedar, `Policy` model, `DEFAULT_POLICIES` seeded on org create (behaviour-preserving), `abacProcedure`, rewire the destructive mutations through it, `audit.ts` writer, Policies UI (Cedar editor + validate + simulate). Roles still work unchanged for anyone who ignores it.

**Phase 3 — Enterprise SSO + ReBAC:** `@better-auth/sso` (OIDC then SAML), `SsoProvider` model, per-org wizard, email-domain routing, SCIM-less just-in-time member provisioning with claim→attribute mapping. `Team`/`ResourceGrant` ownership + the no-code policy builder + list-endpoint policy *filtering*.

**Phase 4 — polish/enterprise:** policy versioning/history (reuse `AuditLog` + a `PolicyVersion` table), break-glass owner override, policy import/export, optional OPA/OpenFGA export for orgs that standardize elsewhere, SCIM provisioning, IP-allowlist context policies.

## Dependencies
- **Email sender** (shared infra): magic link + SSO JIT invites need an email path. Coordinate with whatever epic owns SMTP/Resend config; store it the same DB-config-with-encrypted-secret way. Until then, magic link is gated off and passkeys/social work without email.
- **`SWARMY_SECRET_KEY`** env var (new, required for encrypted provider/SSO secrets) — add to `.env.example` next to `BETTER_AUTH_SECRET`; document key-rotation (re-encrypt on rotate).
- **Org lifecycle hook** to seed `DEFAULT_POLICIES` — hook into the organization plugin's create flow (Better Auth org `afterCreate`/database hook) or the org-create tRPC path.
- **`CONTROLLER_PUBLIC_URL`** (already exists) must be correct for OAuth callbacks / SAML ACS — surfaced in the UI; a misconfig is the #1 OAuth failure, so we validate it.
- No dependency on the agent, ingress, metrics, or volumes epics. ABAC's audit writer *complements* the audit story other epics also touch.

## Risks & open questions
- **Cedar-WASM under Bun.** Primary risk. Mitigation: thin `PolicyEngine` interface so we can swap to the hand-rolled predicate evaluator (or CEL) without touching `abacProcedure`. Validate `@cedar-policy/cedar-wasm` import + eval under Bun in a spike before committing Phase 2.
- **List-endpoint authorization is filtering, not gating.** A `member` who may see only `env=staging` services needs `nodes.list`/`services.list` to *filter rows by policy*, not just allow/deny the call. Evaluating per-row is O(n) policy checks; mitigate with a "decision over a set" path (Cedar partial eval / batch) and caching. MVP: gate the *call*, filter in Phase 3.
- **Default-policy drift.** As we add actions/routers, `DEFAULT_POLICIES` must keep pace or new endpoints are ungoverned. Mitigation: an action enum in `@swarmy/abac` is the single registry; a test asserts every `abacProcedure` action appears in the default policy set and in the Cedar schema.
- **Auth rebuild atomicity / in-flight requests.** Swapping the instance mid-request must not drop sessions. Mitigation: rebuild constructs the new instance fully, then atomically swaps the reference; in-flight requests keep their captured instance. Sessions live in DB/cookies, unaffected by rebuild.
- **Better Auth `sso` plugin schema vs our `SsoProvider`.** Open question: own the table vs let the plugin own it. Lean: let the plugin own its storage; `SsoProvider` becomes our admin projection if the plugin's shape is awkward. Resolve during the SSO spike.
- **Multi-tenant social secrets.** Hosted-cloud question: one GitHub OAuth app for the whole platform vs per-org apps. MVP = instance-wide (self-host norm). The `orgId?` column on `AuthProviderConfig` leaves room for per-org overrides later without a migration.
- **Lockout safety.** A bad `forbid` policy could lock owners out. Mitigation: a non-deletable `isdefault` super-policy `permit(principal in Role::"owner", action, resource)` with highest priority that custom forbids cannot override for owners on `policy.*`/`member.*` (a guarded break-glass), plus the simulator to catch mistakes pre-save.

## Simplicity note
Defaults preserve "anyone can just deploy." A fresh install boots with exactly today's behaviour: email+password (or whatever env-seeded provider), `owner/admin/member` roles enforced by the *seeded* default policies — the user never sees Cedar, never writes a policy, never configures a provider. Turning on GitHub login is *one toggle + paste two fields + copy one URL*, applied live with no restart. ABAC is invisible until an admin chooses to write a rule, and even then the no-code builder generates the policy so they need not learn Cedar. Enterprise SSO is opt-in per org and self-service via a wizard that tells the admin exactly what to paste where. Every advanced capability is additive and individually disableable; the zero-config path is untouched.
