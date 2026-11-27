---
paths:
  - 'apps/agent/**'
  - 'packages/core/src/protocol/**'
  - 'apps/api/src/gateway/**'
  - 'apps/api/src/install/**'
  - 'scripts/install-swarmy.sh'
---

# Agent, protocol and install

Load `agent-handlers`; for the agent CLI, doctor, install repair or recovery claims, also
`node-recovery`.

- BR-004: nodes need zero inbound ports; the controller never opens a socket to a node.
- BR-005, DR-006: the agent is a host binary under systemd.
- BR-011: the protocol only grows; a new capability is a new message type or an optional
  field, and every message has a parse test.
- DR-007, DR-008: enrolment is a pasted POSIX sh one-liner, the token in the environment.
- DR-009: recovery is the same install line plus a fingerprint claim a person approves.
