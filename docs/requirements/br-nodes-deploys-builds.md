# Business requirements: nodes, deploys and builds

Proposed capability records. "Built" says how far the code is: "Needs live run" means the code and unit tests exist but nobody has proved it on a real multi-node, multi-region swarm.

## BR-017

- Status: Proposed
- Revision: 1
- Built: Shipped (e2e gate)

WHEN someone pastes the install line on a fresh Linux box, THE SYSTEM SHALL install Docker if missing, run the agent under systemd, form or join the swarm, and show the node online.

## BR-018

- Status: Proposed
- Revision: 1
- Built: Shipped

Join tokens travel in an environment variable, never a URL; only a hash is stored and the plaintext shows once.

## BR-019

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN the installer runs again on an enrolled box, THE SYSTEM SHALL repair it in place with the same identity and never create a duplicate node.

## BR-020

- Status: Proposed
- Revision: 1
- Built: Shipped

A node that lost every credential comes home through a fingerprinted claim a person approves; a claim never enrols a new node.

## BR-021

- Status: Proposed
- Revision: 1
- Built: Shipped

`swarmy-agent doctor` diagnoses the box from binary to disk with the daemon or controller down; risky fixes need a typed phrase.

## BR-022

- Status: Proposed
- Revision: 1
- Built: Shipped

With the controller dark, the agent CLI exports or pushes a stack's volumes with the operator's own credentials.

## BR-023

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN agent and controller versions differ, THE SYSTEM SHALL say so in plain words and offer Upgrade agent.

## BR-024

- Status: Proposed
- Revision: 1
- Built: Shipped

Promote and demote refuse any change that leaves the swarm without a manager majority; moving a service checks every refusal before copying.

## BR-025

- Status: Proposed
- Revision: 1
- Built: Shipped (CI gate)

Compose import and export are lossless: keys swarmy doesn't model survive, and lossy changes are flagged.

## BR-026

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN any deploy, canary or rollback runs, THE SYSTEM SHALL run admission (guardrails, exposure, image policy); a block needs an audited admin override.

## BR-027

- Status: Proposed
- Revision: 1
- Built: Shipped

Every deploy is a release with its compose, digests, actor and verdict, a diff, and one-click rollback that runs as a new release.

## BR-028

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN a health gate is on, THE SYSTEM SHALL judge the release after its window and roll back if degraded; the gate survives losing the database.

## BR-029

- Status: Proposed
- Revision: 1
- Built: Shipped

Canary releases split traffic by weight, promote after a clean window and roll back on an error-rate breach.

## BR-030

- Status: Proposed
- Revision: 1
- Built: Shipped

Secret variables live only as Docker secrets: write-only, reveal needs permission and is audited, rotation is versioned.

## BR-031

- Status: Proposed
- Revision: 1
- Built: Shipped

Idle services sleep to zero only when nothing has seen traffic, and wake on a signed link.

## BR-032

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN a verified push arrives, THE SYSTEM SHALL build with rootless BuildKit on a builder node (Railpack when there's no Dockerfile), push to the in-swarm registry and deploy by digest.

## BR-033

- Status: Proposed
- Revision: 1
- Built: Shipped

Every build is CVE-scanned; with policy on, unsigned or critical-CVE images are blocked and a failed signature check fails closed.

## BR-034

- Status: Proposed
- Revision: 1
- Built: Shipped (CI gate)

Image cleanup never deletes a digest that is running.

## BR-035

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN a pull request opens, THE SYSTEM SHALL build a preview at `pr-N.<base>` and remove it on close or expiry; fork PRs never build automatically.

## BR-036

- Status: Proposed
- Revision: 1
- Built: Shipped

Swarmy.yaml compiles to plain compose; destructive steps wait for a person, and drift is reported, never silently reverted.

## BR-037

- Status: Proposed
- Revision: 1
- Built: Not started; DR-046 decided how

The dashboard can commit a swarmy.yaml change and open a pull request.

## BR-038

- Status: Proposed
- Revision: 1
- Built: Needs live run

WHEN an admin clicks Upgrade, THE SYSTEM SHALL check, back up, then upgrade controller, agents and system services in order behind health gates, survive the controller restarting, and stop with a plain reason on failure.

## BR-039

- Status: Proposed
- Revision: 1
- Built: Needs live run

A platform manifest that fails signature checks is never used.

## BR-040

- Status: Proposed
- Revision: 1
- Built: Needs live run

An estate with no internet route installs and upgrades from a signed offline bundle.

## BR-041

- Status: Proposed
- Revision: 1
- Built: Partial: ACME CA setting, Docker install URL and the agent's default controller URL remain

Nothing swarmy runs day to day needs a third-party service; every default external address has a setting.

## BR-042

- Status: Proposed
- Revision: 1
- Built: Needs live run

Developer platform: sign-in for your apps, database studio, error tracking, session replay and analytics, queues, email, CLI and MCP.
