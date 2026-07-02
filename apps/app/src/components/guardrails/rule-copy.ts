import type { GuardrailRuleId } from '@swarmy/core';

/**
 * Plain-English copy for each guardrail rule — the Governance page speaks
 * human, not policy-engine. Wire types stay in @swarmy/core; only the words
 * live here.
 */
export interface GuardrailRuleCopy {
  title: string;
  description: string;
  /** When set, the rule exposes one numeric parameter under this key. */
  paramKey?: string;
  paramLabel?: string;
}

export const RULE_COPY: Record<GuardrailRuleId, GuardrailRuleCopy> = {
  noLatestTagInProd: {
    title: 'No :latest images in production',
    description:
      'Do not deploy :latest (or untagged) images to production — pin a version so rollbacks mean something.',
  },
  minDbReplicasProd: {
    title: 'Minimum database replicas in production',
    description:
      'Production databases need read replicas to survive losing a node. Below the minimum, the deploy is flagged.',
    paramKey: 'n',
    paramLabel: 'Min replicas',
  },
  requireBackupPolicy: {
    title: 'Databases must have a backup policy',
    description:
      'A stack with a database needs a backup schedule (on the cluster or a volume) before it ships.',
  },
  requireHealthcheck: {
    title: 'Services must define a healthcheck',
    description:
      'Without a healthcheck, swarm cannot tell a healthy container from a wedged one during rollouts.',
  },
  requireResourceLimits: {
    title: 'Services must set a memory limit',
    description:
      'An unbounded service can eat a node. Every spec should cap its memory.',
  },
  requireSignedImagesProd: {
    title: 'Production images must be signed',
    description:
      'When Registry policy already verifies signatures, that check applies; this rule flags prod deploys while signing enforcement is switched off.',
  },
  noPrivilegedContainers: {
    title: 'No privileged containers',
    description:
      'Privileged mode is root on the host. Grant specific capabilities instead.',
  },
  noHostPortsProd: {
    title: 'No host-mode ports in production',
    description:
      'Host-mode ports pin traffic to one node and bypass the routing mesh — publish through ingress instead.',
  },
};
