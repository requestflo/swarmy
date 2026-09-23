# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Email
**security@gomacrae.com**. Include the
affected version and component and the steps to reproduce, and say whether you
think it's being exploited. We'll acknowledge the report, keep you posted while
we fix it, and credit you in the release notes if you'd like.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes: security fixes are released as 1.x patch releases |
| < 1.0 | No |

## Secure defaults

A self-host install is locked down out of the box:

- **Invite-only sign-up.** Only the owner the installer seeds and people an admin
  invites can create accounts. This covers email, social/SSO, magic-link and
  passkey sign-ups, and org creation is gated the same way. To open it up, set
  `SWARMY_ALLOW_SIGNUP=true` (installer: `--allow-signup`).
- **Short-lived bootstrap token.** The join token the installer prints lasts
  24 hours / 5 uses. Agents reconnect on their own stored session.
- **Registry auth.** When you enable the in-swarm registry, swarmy generates a
  login, stores it encrypted, and uses it on every push and pull. Rotating it is
  admin-only.
- **Secrets in Docker secrets.** Controller keys, passwords and join tokens are
  mounted as Docker secrets (`*_FILE`), never set in the service spec or visible
  in `docker inspect`. Garage and ClickHouse credentials use Docker secrets too,
  not configs. Credentials swarmy stores are encrypted with `SWARMY_SECRET_KEY`.
- **Rate-limited auth, per client IP.** Sign-in, sign-up and password-reset
  limits apply per real client IP, taken from the socket. `X-Forwarded-For`
  counts only when the request comes from an address in
  `SWARMY_TRUSTED_PROXIES`, which defaults to loopback only. If you run your
  own reverse proxy in front of the controller, add it to that list.
- **Terminal access.** Container exec is RBAC-gated, audited and recorded. A
  root shell on a host stays off until an admin turns it on for that node. On
  the node itself, `SWARMY_ALLOW_EXEC=false` or `SWARMY_ALLOW_NODE_SHELL=false`
  vetoes either one.
- **Agents dial out.** Each agent opens an authenticated WebSocket to the
  controller. The controller never touches a node's Docker socket, and the
  agent listens on no inbound port.

Keep `/var/lib/swarmy/install/state.env` private and backed up. It holds
`SWARMY_SECRET_KEY`.
