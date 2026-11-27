---
paths:
  - 'packages/abac/**'
  - 'packages/auth/**'
  - 'packages/trpc/src/trpc.ts'
  - 'packages/trpc/src/abac.ts'
  - 'packages/trpc/src/routers/terminal.ts'
  - 'packages/trpc/src/services/*audit*'
  - 'packages/trpc/src/services/*admission*'
  - 'packages/trpc/src/services/*guardrail*'
  - 'packages/db/prisma/schema/access.prisma'
---

# Access, identity and audit

Load `auth-abac` before editing.

- BR-009: everything is keyed by org, with no path between orgs.
- BR-007, DR-037: one audit writer, which also records every denial.
- BR-010: a stored credential is never returned to a client.
- DR-036: attribute-based policy with role as one attribute; destructive actions gated.
- DR-038: your own IdP owns MFA; swarmy 2FA stays optional.
- DR-043: a shell into a service that mounts secrets needs `secrets.read` too, and its
  recording is encrypted at rest (BR-086).
