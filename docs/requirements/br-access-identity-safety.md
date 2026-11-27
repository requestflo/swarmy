# Business requirements: access, identity and safety

Proposed capability records. "Built" says how far the code is: "Needs live run" means the code and unit tests exist but nobody has proved it on a real multi-node, multi-region swarm.

## BR-076

- Status: Proposed
- Revision: 1
- Built: Shipped

Every call is org-scoped; a non-member is refused before any query runs.

## BR-077

- Status: Proposed
- Revision: 1
- Built: Shipped

Every change by a person, API key, worker or agent writes one audit row, and every policy denial is audited.

## BR-078

- Status: Proposed
- Revision: 1
- Built: Shipped

The dashboard and REST run destructive actions through the same policy check and write the same audit row.

## BR-079

- Status: Proposed
- Revision: 1
- Built: Shipped

Members deploy, configure, scale and restart freely outside production; production deploys, destructive actions, terminals, secret reveal and mesh access need an explicit grant.

## BR-080

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN production safety is on, THE SYSTEM SHALL block risky production deploys (`:latest`, no healthcheck, privileged, host ports, an unbacked single-copy database) unless an admin overrides with a written reason.

## BR-081

- Status: Proposed
- Revision: 1
- Built: Shipped

A rule change that would leave no owner able to change rules is refused.

## BR-082

- Status: Proposed
- Revision: 1
- Built: Partial: SAML needs a real-IdP pass, and encrypted assertions aren't supported

People sign in through any OIDC or SAML provider or a social login; username and password stay available and email is never required.

## BR-083

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN an org requires SSO, THE SYSTEM SHALL refuse every other sign-in except an audited owner break-glass with password and 2FA.

## BR-084

- Status: Proposed
- Revision: 1
- Built: Shipped

Signing out, revoking a session or resetting 2FA also ends API and forward-auth access.

## BR-085

- Status: Proposed
- Revision: 1
- Built: Shipped

The web terminal opens only through one policy check, with optional four-eyes approval, a single-use ticket and recorded output for node shells.

## BR-086

- Status: Proposed
- Revision: 1
- Built: Not started; DR-043 decided how

A terminal into a service that mounts secrets can't get around the secret-reveal permission or record secret values (finding M13)

## BR-087

- Status: Proposed
- Revision: 1
- Built: Shipped

Secret-looking values and flags are masked for anyone without secret-reveal permission.
