---
title: "Account security"
description: "Two-factor, terminal step-up, session limits and getting a locked-out owner back in."
---

This page covers what swarmy enforces, the decisions behind it, and how to get
a locked-out owner back in.

**Two-factor is optional.** Nothing is enforced
by default: no org requirement, no terminal step-up, no MFA wall. The expected
way in is SSO or a social login (Microsoft, Google, GitHub, GitLab, or any
OIDC provider such as Keycloak, Authentik or Zitadel), where the identity
provider owns MFA. Not everyone has an email address, so swarmy never assumes
one. Admins can still opt in to either requirement below.

## Two-factor authentication (authenticator app)

Any user can turn on an authenticator app (TOTP, 6 digits, 30 s) under
**Profile → Security**:

1. Confirm your password. Accounts without a password (SSO or magic-link
   only) skip this step.
2. Scan the QR code, or type the secret into your app by hand.
3. Enter the 6-digit code. 2FA turns on only after this step.
4. Save the **10 backup codes** (format `aB3xk-9Qm2z`). They are shown once.
   Each works once. **Regenerate** replaces the whole set. They are stored
   encrypted.

**Disable** needs your password.

The sign-in challenge works like this:

- **Password sign-in**: after the password, the login page asks for a code
  or a backup code.
- **Magic-link sign-in** by a user who has 2FA enabled: the session starts
  *pending*. The dashboard asks for a code before it shows anything. Until
  then every org API call returns `MFA_CHALLENGE_REQUIRED`.
- **Social and SSO sign-ins** (Microsoft, Google, GitHub, GitLab, OIDC) are
  never challenged by swarmy. **Decision:** the identity provider owns MFA for
  federated logins, and a second prompt on top of the IdP's own is friction
  without much gain.

**API keys and OAuth clients** (the REST API, SDKs, Terraform) are separate
scoped, hashed credentials. They are not user sessions, so 2FA and the org
wall do not apply to them. Scope and revoke them under Settings → API keys.

After 10 wrong codes in a row, the account locks for 15 minutes. This applies
both at sign-in and to in-session step-up.

## "Require two-factor for password accounts" (org opt-in)

A single switch under **Settings → Access → Security**, **off by default**.
When on, every member who signs in with a password gets a 7-day grace period
to add an authenticator app. Members who sign in only through SSO or a social
account are exempt: their provider owns MFA. (The API still accepts the finer
`require2fa: off|admins|all`, `graceDays` and `trustIdpMfa` fields; the
dashboard shows only the switch.)

- The grace clock starts when the policy is switched on, or when a member
  joins, whichever is later.
- Member states: **Enrolled**, **Grace (due date)**, **Blocked**,
  **Exempt (SSO)**, and **Not required**.
- A **blocked** member can still sign in and reach the 2FA setup screen.
  Everything else in that workspace returns `TWO_FACTOR_ENROLMENT_REQUIRED`
  until they enrol.
- You can't require 2FA with a 0-day grace period until you have enrolled
  yourself, so you can't lock yourself out by saving.
- **Reset a member's 2FA** (lost phone): an admin can do this for a member,
  and an owner for anyone. It removes their authenticator and signs them out
  everywhere. It is refused for your own account (use Disable), for someone
  who outranks you, and for a user who also belongs to another workspace:
  users are global, so one org's admin must not weaken an account another org
  relies on. Those cases go through the CLI below.

## Terminal: step-up, session limits, audit

The org **Terminal policy** (Settings → Security → Terminal) is now enforced:

- **Require recent MFA** (**off by default**, opt-in). When on, opening a
  container exec or a host shell requires a second factor within **MFA valid
  for** (default 15 min, range 1 min–12 h). A code entered at sign-in counts.
  Otherwise the dashboard shows a step-up prompt for a code or backup code.
  Password users without 2FA are told to enrol first. SSO/social-only users
  are let through while the org trusts IdP MFA (the default). Every refusal is
  audited as `terminal.stepup.required`. Who may open a terminal at all is an
  access policy (`terminal.open`), not an MFA question.
- **Idle timeout** (default 5 min, no keystrokes) and **max session length**
  (default 1 h) are enforced by the controller's terminal data plane. They no
  longer depend on the agent. The shell closes with `idle timeout` or
  `session time limit reached`.
- Audit trail: `terminal.open` (ticket minted), `terminal.connect` (socket
  attached, with the limits in force), and `terminal.close` (with the reason:
  `closed`, `exit`, `killed`, `idle_timeout`, `max_session`, and so on, plus
  bytes and whether it was recorded). Admin kills are `terminal.kill`.

Passkeys will count as a second factor once the passkey plugin ships on the
controller (`/sign-in/passkey` is already treated as MFA-verified). Today,
step-up is by TOTP or backup code.

## Recovery: locked-out owner (lost authenticator and backup codes)

This recovery is a controller CLI on purpose. Only someone who can exec into
the controller, and so already holds its database, can run it. It removes the
user's authenticator and backup codes, turns 2FA off, and signs them out
everywhere. It is audited as `security.twoFactor.reset` (`via:
controller-cli`, actor `system`) in each of their workspaces.

Run it inside the running controller. It opens the controller's SQLite store
(`control.db`) alongside the controller process; nothing needs to stop, and
nodes and running apps are not affected.

```bash
docker exec -it $(docker ps -q -f name=swarmy_controller) \
  bun run apps/api/src/reset-2fa.ts --email owner@example.com
```

Use `--user <username>` for an account without an email.

Then sign in with your password and enrol again. If the org requires 2FA,
your grace period does not restart, so enrol right away. If you have also lost
the password, use the normal password-reset flow.
