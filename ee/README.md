<!-- SPDX-License-Identifier: LicenseRef-swarmy-Enterprise -->

# swarmy Enterprise (`ee/`)

This directory — and any other path explicitly marked as enterprise (`ee/`,
`apps/*/src/ee/**`, `packages/enterprise/*`) — holds **commercial, enterprise-only**
code.

## The open-core split

| | Rest of the repo | `ee/` (this directory) |
|---|---|---|
| License | [FSL-1.1-ALv2](../LICENSE.md) (Functional Source License) | [swarmy Enterprise License](./LICENSE) (Elastic-2.0-style) |
| Converts to OSS? | **Yes** — Apache-2.0, 2 years after each release, automatic | **No** — never converts |
| Self-host for your own / clients' use | Yes | Yes, with a valid license key |
| Resell as a competing managed service | No | No |

Everything outside `ee/` is FSL-1.1-ALv2 and converts to Apache-2.0 two years
after the release it shipped in. Everything inside `ee/` is governed by the
non-converting [swarmy Enterprise License](./LICENSE).

## One repo, one build

Enterprise code lives in the same tree as the community code — there is no secret
repo and no separate build. Enterprise features are **gated at runtime** behind a
license-key check (`SWARMY_LICENSE_KEY`). A community build without a key simply
does not enable EE features; the code is present but inert.

The license-key verification module itself
(`apps/api/src/license.ts`) is the first EE-governed surface. See
`isEnterpriseEnabled()` there for the gate. Wrap any enterprise-only behaviour in
that check:

```ts
import { isEnterpriseEnabled } from '../license';

if (isEnterpriseEnabled()) {
  // enterprise-only path
}
```

## Contributing

Contributions to `ee/` are accepted under the swarmy Enterprise License, not the
FSL. Contributions to the rest of the repo are inbound under FSL — see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
