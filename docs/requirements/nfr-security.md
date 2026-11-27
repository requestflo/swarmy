# Non-functional requirements: security

Quality targets under ISO/IEC 25010:2023 "Security". Every number is already in swarmy's docs or code; "Checked by" says how far it is proven.

## NFR-024 · Revoking mesh access

- Status: Proposed
- Revision: 1
- Target: Within 30 s (measured 1.6 s)
- Checked by: Manual script on Lima

## NFR-025 · Terminal sessions

- Status: Proposed
- Revision: 1
- Target: 30 s single-use ticket; idle 5 min, max 1 h; step-up MFA valid 15 min
- Checked by: Terminal tests

## NFR-026 · Two-factor

- Status: Proposed
- Revision: 1
- Target: 15 min lock after 10 wrong codes; 10 single-use backup codes; 7 days' grace when an org requires 2FA
- Checked by: Two-factor and MFA-policy tests

## NFR-027 · Recovery claims

- Status: Proposed
- Revision: 1
- Target: Expire in 15 min; the credential is delivered once
- Checked by: Recovery test

## NFR-028 · Sign-out reach

- Status: Proposed
- Revision: 1
- Target: Forward-auth permits cached at most 15 s and dropped on sign-out
- Checked by: Token-revocation test

## NFR-029 · GitHub tokens

- Status: Proposed
- Revision: 1
- Target: 1-hour installation tokens, cached at most 55 min, never stored
- Checked by: GitHub App test

## NFR-030 · Request size

- Status: Proposed
- Revision: 1
- Target: 32 MB overall, 10 MB webhooks, 256 KB inbound webhook bodies, 256 KB swarmy.yaml
- Checked by: Webhook tests; overall limit untested

## NFR-031 · Webhook replay

- Status: Proposed
- Revision: 1
- Target: Deliveries remembered for 7 days
- Checked by: Dedupe test

## NFR-032 · AI key abuse

- Status: Proposed
- Revision: 1
- Target: 600 requests/min per key by default; 20 bad keys/min from one address gets a 429
- Checked by: AI limits test
