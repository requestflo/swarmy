import { describePolicy, parsePolicyDoc, type Condition, type PolicyDoc } from '@swarmy/abac/model';

/**
 * The rules editor's form model. A rule is WHO × ACTIONS × WHERE; the editor
 * edits this draft and the JSON document is derived from it. Documents that use
 * clauses the pickers can't express (ReBAC relations, owner-only, attribute
 * matches) open in the JSON editor instead — nothing is silently dropped.
 */

export type Who = 'everyone' | 'role' | 'group' | 'member';
export type EnvScope = 'any' | 'production' | 'non-production' | 'custom';
export type ResourceScope = 'any' | 'service' | 'stack' | 'node';

export interface LabelMatch {
  key: string;
  value: string;
}

export interface RuleDraft {
  name: string;
  effect: 'permit' | 'forbid';
  who: Who;
  roles: string[];
  groups: string[];
  members: string[];
  actions: string[];
  resourceType: ResourceScope;
  env: EnvScope;
  customEnv: string;
  labels: LabelMatch[];
}

export const EMPTY_DRAFT: RuleDraft = {
  name: '',
  effect: 'permit',
  who: 'group',
  roles: ['member'],
  groups: [],
  members: [],
  actions: ['service.deploy'],
  resourceType: 'any',
  env: 'production',
  customEnv: '',
  labels: [],
};

export function draftToDoc(d: RuleDraft): PolicyDoc {
  const doc: PolicyDoc = { actions: d.actions.length ? d.actions : ['*'] };
  if (d.who === 'role' && d.roles.length) doc.roles = d.roles;
  if (d.who === 'group' && d.groups.length) doc.groups = d.groups;
  if (d.who === 'member' && d.members.length) doc.members = d.members;
  if (d.resourceType !== 'any') doc.resourceTypes = [d.resourceType];
  const conditions: Condition[] = [];
  if (d.env === 'production') conditions.push({ attr: 'resource.env', op: 'eq', value: 'production' });
  if (d.env === 'non-production') conditions.push({ attr: 'resource.env', op: 'ne', value: 'production' });
  if (d.env === 'custom' && d.customEnv.trim()) {
    conditions.push({ attr: 'resource.env', op: 'eq', value: d.customEnv.trim() });
  }
  for (const l of d.labels) {
    if (l.key.trim()) conditions.push({ attr: `resource.label.${l.key.trim()}`, op: 'eq', value: l.value });
  }
  if (conditions.length) doc.conditions = conditions;
  return doc;
}

const EDITABLE = new Set(['actions', 'roles', 'groups', 'members', 'resourceTypes', 'conditions']);

/** Draft for an existing rule, or null when only the JSON editor can express it. */
export function docToDraft(name: string, effect: 'permit' | 'forbid', doc: PolicyDoc): RuleDraft | null {
  if (Object.keys(doc).some((k) => !EDITABLE.has(k))) return null;
  const draft: RuleDraft = { ...EMPTY_DRAFT, name, effect, labels: [], env: 'any' };
  draft.actions = doc.actions?.includes('*') ? [] : [...(doc.actions ?? [])];
  const whoKinds = [doc.roles?.length, doc.groups?.length, doc.members?.length].filter(Boolean).length;
  if (whoKinds > 1) return null;
  draft.who = doc.groups?.length ? 'group' : doc.members?.length ? 'member' : doc.roles?.length ? 'role' : 'everyone';
  draft.roles = doc.roles ?? ['member'];
  draft.groups = doc.groups ?? [];
  draft.members = doc.members ?? [];
  const types = doc.resourceTypes ?? [];
  if (types.length > 1) return null;
  draft.resourceType = (types[0] as ResourceScope | undefined) ?? 'any';
  for (const c of doc.conditions ?? []) {
    if (c.attr === 'resource.env' && draft.env === 'any') {
      if (c.op === 'eq' && c.value === 'production') draft.env = 'production';
      else if (c.op === 'ne' && c.value === 'production') draft.env = 'non-production';
      else if (c.op === 'eq') {
        draft.env = 'custom';
        draft.customEnv = String(c.value);
      } else return null;
    } else if (c.attr.startsWith('resource.label.') && c.op === 'eq') {
      draft.labels.push({ key: c.attr.slice('resource.label.'.length), value: String(c.value) });
    } else return null;
  }
  return draft;
}

/** Parse JSON source → { doc, sentence } or the parse error. */
export function previewSource(
  source: string,
  effect: 'permit' | 'forbid',
): { doc: PolicyDoc; sentence: string } | { error: string } {
  try {
    const doc = parsePolicyDoc(source);
    return { doc, sentence: describePolicy(effect, doc) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
