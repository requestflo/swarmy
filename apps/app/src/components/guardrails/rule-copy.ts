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
    title: 'No :latest in production',
    description: 'Pin a version, so a restart never pulls a surprise and putting back an old version means something.',
  },
  minDbReplicasProd: {
    title: 'Production databases keep standby copies',
    description: 'A production database needs a copy on another server, so losing one server loses no data.',
    paramKey: 'n',
    paramLabel: 'At least',
  },
  requireBackupPolicy: {
    title: 'Databases are backed up',
    description: 'An app with a database needs a backup schedule before it ships.',
  },
  requireHealthcheck: {
    title: 'Every service says when it’s healthy',
    description: 'Without a health check swarmy can’t tell a working service from a stuck one while it rolls out.',
  },
  requireResourceLimits: {
    title: 'Every service has a memory limit',
    description: 'A service with no limit can eat a whole server.',
  },
  requireSignedImagesProd: {
    title: 'Production images are signed',
    description: 'Only images built by swarmy CI or signed with your key go to production. Registry signing checks apply when they’re on.',
  },
  noPrivilegedContainers: {
    title: 'No privileged containers',
    description: 'Privileged mode is root on the server. Grant the specific capabilities instead.',
  },
  noHostPortsProd: {
    title: 'Production traffic comes through the front door',
    description: 'Host ports tie traffic to one server and skip the front door; publish through a domain instead.',
  },
};
