import { describe, expect, it } from 'bun:test';
import { parsePolicyDoc } from '@swarmy/abac/model';
import { docToDraft, draftToDoc, EMPTY_DRAFT, previewSource } from './policy-draft';

describe('rules editor draft ⇄ policy document', () => {
  it('round-trips a group + production + label rule', () => {
    const draft = {
      ...EMPTY_DRAFT,
      name: 'platform prod',
      groups: ['platform'],
      actions: ['service.deploy', 'terminal.open'],
      resourceType: 'service' as const,
      env: 'production' as const,
      labels: [{ key: 'team', value: 'payments' }],
    };
    const doc = parsePolicyDoc(JSON.stringify(draftToDoc(draft)));
    expect(docToDraft('platform prod', 'permit', doc)).toEqual(draft);
  });

  it('non-production maps to resource.env ne production', () => {
    const doc = draftToDoc({ ...EMPTY_DRAFT, who: 'role', roles: ['member'], env: 'non-production' });
    expect(doc.conditions).toEqual([{ attr: 'resource.env', op: 'ne', value: 'production' }]);
  });

  it('rules the pickers cannot express open as JSON', () => {
    expect(docToDraft('x', 'permit', { relations: ['operator'], actions: ['service.deploy'] })).toBeNull();
    expect(docToDraft('x', 'permit', { roles: ['member'], groups: ['a'] })).toBeNull();
  });

  it('previews a sentence or the parse error', () => {
    const ok = previewSource(JSON.stringify({ groups: ['platform'], actions: ['secrets.read'] }), 'forbid');
    expect('sentence' in ok && ok.sentence).toBe('Members of platform can never read secrets.');
    expect('error' in previewSource('{', 'permit')).toBe(true);
  });
});
