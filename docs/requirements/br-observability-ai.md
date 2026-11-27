# Business requirements: observability and AI

Proposed capability records. "Built" says how far the code is: "Needs live run" means the code and unit tests exist but nobody has proved it on a real multi-node, multi-region swarm.

## BR-088

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN an app's observability switch is on, THE SYSTEM SHALL add OpenTelemetry settings on its next deploy without overwriting the app's own, and run one collector and one ClickHouse for the whole estate; switched off, the app runs unchanged.

## BR-089

- Status: Proposed
- Revision: 1
- Built: Shipped

Every trace, metric and log query is built by the controller and limited to the asking org.

## BR-090

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN the collector or its store is down, THE SYSTEM SHALL say health checks are blind and never show green.

## BR-091

- Status: Proposed
- Revision: 1
- Built: Needs live run

Apps with no instrumentation still get their container output in the log store.

## BR-092

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN an alert fires, THE SYSTEM SHALL dedupe it, open or update an incident and show it on the public status page; every fire, resolve and override is audited.

## BR-093

- Status: Proposed
- Revision: 1
- Built: Shipped

Unmodified Sentry SDKs work by pointing their DSN at swarmy.

## BR-094

- Status: Proposed
- Revision: 1
- Built: Shipped

Web analytics default to private mode (no cookies, IP dropped); identified mode and session replay run only after consent.

## BR-095

- Status: Proposed
- Revision: 1
- Built: Shipped

Model provider keys never leave the controller; apps hold revocable virtual keys whose rate and budget limits are enforced before the upstream call.

## BR-096

- Status: Proposed
- Revision: 1
- Built: Shipped

Only admins set model provider addresses, and private-network addresses are refused unless they're known swarmy services.

## BR-097

- Status: Proposed
- Revision: 1
- Built: Needs live run

The controller reaches in-cluster Ollama or vLLM by service name across nodes over an encrypted network.
