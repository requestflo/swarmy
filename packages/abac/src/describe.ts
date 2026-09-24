import type { Action } from './types';
import type { PolicyDoc } from './policy';
import type { Condition } from './attrs';

/**
 * Plain-words rendering of the policy model for the admin rules editor:
 * "Members of platform can deploy and restart on apps where env is production."
 * Pure and shared, so the list, the editor preview and tests agree.
 */

export interface ActionInfo {
  id: Action;
  /** Short verb phrase used in sentences ("deploy", "destroy data"). */
  label: string;
  group: 'read' | 'operate' | 'configure' | 'destructive' | 'access' | 'governance';
}

export const ACTION_CATALOG: ActionInfo[] = [
  { id: 'node.read', label: 'view nodes', group: 'read' },
  { id: 'service.read', label: 'view apps', group: 'read' },
  { id: 'stack.read', label: 'view stacks', group: 'read' },
  { id: 'ingress.read', label: 'view domains', group: 'read' },
  { id: 'member.read', label: 'view members', group: 'read' },
  { id: 'policy.read', label: 'view policies', group: 'read' },
  { id: 'authconfig.read', label: 'view sign-in settings', group: 'read' },
  { id: 'service.deploy', label: 'deploy apps', group: 'operate' },
  { id: 'stack.deploy', label: 'deploy stacks', group: 'operate' },
  { id: 'service.scale', label: 'scale', group: 'operate' },
  { id: 'service.restart', label: 'restart', group: 'operate' },
  { id: 'node.drain', label: 'drain nodes', group: 'operate' },
  { id: 'service.configure', label: 'change app settings', group: 'configure' },
  { id: 'node.setLabels', label: 'label nodes', group: 'configure' },
  { id: 'ingress.write', label: 'manage domains', group: 'configure' },
  { id: 'token.create', label: 'create join tokens', group: 'configure' },
  { id: 'service.remove', label: 'remove apps', group: 'destructive' },
  { id: 'stack.remove', label: 'remove stacks', group: 'destructive' },
  { id: 'node.remove', label: 'remove nodes', group: 'destructive' },
  { id: 'data.destroy', label: 'destroy data', group: 'destructive' },
  { id: 'data.restore', label: 'restore over live data', group: 'destructive' },
  { id: 'data.failover', label: 'confirm a lossy failover', group: 'destructive' },
  { id: 'backup.remove', label: 'remove backup targets', group: 'destructive' },
  { id: 'secret.delete', label: 'delete secrets', group: 'destructive' },
  { id: 'dns.remove', label: 'remove DNS', group: 'destructive' },
  { id: 'ingress.remove', label: 'remove tunnels', group: 'destructive' },
  { id: 'cicd.remove', label: 'remove git connections', group: 'destructive' },
  { id: 'token.revoke', label: 'revoke tokens', group: 'destructive' },
  { id: 'terminal.open', label: 'open a terminal', group: 'access' },
  { id: 'secrets.read', label: 'read secrets', group: 'access' },
  { id: 'mesh.connect', label: 'join the mesh', group: 'access' },
  { id: 'app.access', label: 'sign in to protected apps', group: 'access' },
  { id: 'ai.use', label: 'use AI models', group: 'access' },
  { id: 'data.read', label: 'read database rows', group: 'access' },
  { id: 'data.write', label: 'edit database rows', group: 'operate' },
  { id: 'member.write', label: 'manage members', group: 'governance' },
  { id: 'policy.write', label: 'edit policies', group: 'governance' },
  { id: 'authconfig.write', label: 'change sign-in settings', group: 'governance' },
];

const LABELS = new Map<string, string>(ACTION_CATALOG.map((a) => [a.id, a.label]));

export function actionLabel(action: string): string {
  return LABELS.get(action) ?? action;
}

function joinWords(xs: string[], conj = 'and'): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`;
}

const ROLE_WORDS: Record<string, string> = { owner: 'Owners', admin: 'Admins', member: 'Members' };
const TYPE_WORDS: Record<string, string> = {
  service: 'apps',
  stack: 'stacks',
  node: 'nodes',
  org: 'the workspace',
};

function attrWords(attr: string): string {
  if (attr === 'resource.env') return 'env';
  if (attr === 'resource.type') return 'type';
  if (attr === 'resource.id') return 'id';
  if (attr.startsWith('resource.label.')) return `label ${attr.slice('resource.label.'.length)}`;
  if (attr === 'principal.groups') return 'their groups';
  return `their ${attr.slice('principal.'.length)}`;
}

export function describeCondition(c: Condition): string {
  const a = attrWords(c.attr);
  const list = (v: unknown) => joinWords((v as string[]) ?? [], 'or');
  switch (c.op) {
    case 'eq':
      return `${a} is ${c.value}`;
    case 'ne':
      return `${a} is not ${c.value}`;
    case 'in':
      return `${a} is ${list(c.value)}`;
    case 'notIn':
      return `${a} is not ${list(c.value)}`;
    case 'exists':
      return `${a} is set`;
    case 'notExists':
      return `${a} is unset`;
  }
}

/** "Members of platform can deploy apps and restart on apps where env is not production." */
export function describePolicy(effect: 'permit' | 'forbid', doc: PolicyDoc): string {
  const who: string[] = [];
  const roles = (doc.roles ?? []).filter((r) => r !== '*');
  const roleWord = roles.length ? joinWords(roles.map((r) => ROLE_WORDS[r] ?? r), 'and') : null;
  if (doc.groups?.length && !doc.groups.includes('*')) {
    who.push(`${roleWord ?? 'Members'} of ${joinWords(doc.groups, 'or')}`);
  } else if (roleWord) {
    who.push(roleWord);
  }
  if (doc.members?.length) who.push(`${doc.members.length === 1 ? 'one named person' : `${doc.members.length} named people`}`);
  if (doc.relations?.length) who.push(`${joinWords(doc.relations, 'or')}s of the resource`);
  if (doc.attributes && Object.keys(doc.attributes).length) {
    who.push(
      `people with ${joinWords(Object.entries(doc.attributes).map(([k, v]) => `${k} = ${String(v)}`))}`,
    );
  }
  if (doc.ownerOnly) who.push('its owners');
  const subject = who.length ? who.join(', ') : 'Everyone';

  const acts = doc.actions?.length && !doc.actions.includes('*')
    ? joinWords(doc.actions.map(actionLabel))
    : 'do anything';
  const verb = effect === 'permit' ? 'can' : 'can never';

  const types = (doc.resourceTypes ?? []).filter((t) => t !== '*');
  const target = types.length ? joinWords(types.map((t) => TYPE_WORDS[t] ?? `${t}s`), 'or') : 'anything';
  const where: string[] = [];
  for (const [k, v] of Object.entries(doc.resourceLabels ?? {})) where.push(`label ${k} is ${String(v)}`);
  for (const c of doc.conditions ?? []) where.push(describeCondition(c));
  const scope = where.length ? ` on ${target} where ${joinWords(where)}` : types.length ? ` on ${target}` : '';

  return `${subject} ${verb} ${acts}${scope}.`;
}
