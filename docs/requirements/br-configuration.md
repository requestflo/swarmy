# Business requirements: configurable by default

The paramount rule. BR-098 outranks every other requirement: when one pulls against it, BR-098 wins unless a decision record says why not. It extends BR-006 (off by default, pluggable) from features to every setting and every job.

## BR-098 · Configurable by default

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27
- Today: Drivers exist for several jobs (BR-099); nobody has audited the code for hard-coded values.

WHEN a team runs swarmy, THE SYSTEM SHALL work with a sensible default and no setup, AND SHALL let the team change any behaviour, or swap the tool that does a job, without code, a fork or a new release.

## BR-099 · Your tool for each job

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27
- Today: Ingress: Caddy, Cloudflare Tunnel or none. Mesh: NetBird, Headscale or none. Object storage: Garage or MinIO. Git: GitHub, GitLab, Gitea or any git URL. Sign-in: OIDC or SAML. Backups: S3 or a node.

WHEN a job has more than one common tool, THE SYSTEM SHALL do it through a driver, ship one default driver, and let the org pick another.

## BR-100 · Every value is a setting

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27
- Today: Some exist (update mode auto/manual/off, image clean-up policy, edge topology); no audit yet.

WHEN code needs a duration, threshold, retention or policy that someone could want different, THE SYSTEM SHALL read it from a named setting with a default, never a hard-coded constant.

## BR-101 · One setting, every front door

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27
- Today: Follows BR-003, BR-007 and BR-015; not checked setting by setting.

WHEN a setting changes, THE SYSTEM SHALL store it once at its owner (estate, org, app or service), show the same value in the dashboard, swarmy.yaml, REST API and Terraform, and audit the change.

## BR-102 · Bring your setup with you

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27
- Today: Compose to swarmy.yaml conversion and a Heroku import exist.

WHEN a team moves from another platform or tool, THE SYSTEM SHALL import its configuration and list what didn't translate, with why.

## BR-103 · Work beside the tools you keep

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27
- Today: Outside registries, S3 backup targets and outgoing webhooks are supported.

WHEN a team keeps an outside tool for a job, THE SYSTEM SHALL connect to it as a target instead of requiring swarmy's own.

## BR-104 · Save and reuse choices

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27
- Today: Not started; blueprints cover apps, not settings.

WHEN an org has set its choices, THE SYSTEM SHALL let it save them as a named profile and apply them to another org or estate.

## BR-105 · Fixed only where it protects you

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27
- Today: These four are fixed today.

WHERE a setting would break the org wall, the vault, the audit log or the no-inbound-ports rule (BR-004, BR-007, BR-009, BR-010), THE SYSTEM SHALL keep one fixed behaviour, and a decision record SHALL say why.
