import { describe, expect, it } from 'bun:test';
import { parseIntents, type IntentWorld } from './intents';
import { slugName } from './intents-deploy';

const world: IntentWorld = {
  apps: [{ name: 'storefront', hosts: ['shop.northwind.dev'] }],
  parts: [],
  templates: [
    { id: 'ghost', name: 'Ghost' },
    { id: 'n8n', name: 'n8n' },
    { id: 'wordpress', name: 'WordPress' },
  ],
  servers: ['mgr-1', 'wkr-1'],
};
const first = (q: string) => parseIntents(q, world)[0];

describe('deploy intents', () => {
  it('"deploy ghost as blog" deploys the Ghost template named blog', () => {
    const i = first('deploy ghost as blog');
    expect(i?.id).toBe('deploy:ghost:blog');
    expect(i?.verb).toBe('Deploy');
    expect(i?.action).toEqual({ kind: 'deploy', template: 'ghost', name: 'blog', to: null, server: null });
  });

  it('offers Configure with the name carried over, as the edit and a jump', () => {
    const all = parseIntents('deploy ghost as blog', world);
    const edit = { kind: 'go' as const, to: '/deploy/$template', params: { template: 'ghost' }, search: { name: 'blog' } };
    expect(all[0]?.edit).toEqual(edit);
    expect(all[1]).toMatchObject({ group: 'Jump to', action: edit });
  });

  it('names the app after the template when no name is given', () => {
    expect(first('deploy wordpress')?.action).toMatchObject({ template: 'wordpress', name: 'wordpress' });
  });

  it('matches template names and prefixes, in any case', () => {
    expect(first('deploy WordPress')?.action).toMatchObject({ template: 'wordpress' });
    expect(first('deploy gh as Blog')?.action).toMatchObject({ template: 'ghost', name: 'blog' });
  });

  it('parses "to <server>" in either order, without pinning', () => {
    expect(first('deploy ghost to london')?.action).toMatchObject({ name: 'ghost', to: 'london', server: null });
    expect(first('deploy ghost as blog to mgr')?.action).toMatchObject({ name: 'blog', to: 'mgr', server: 'mgr-1' });
    expect(first('deploy ghost on wkr-1 as blog')?.action).toMatchObject({ name: 'blog', server: 'wkr-1' });
  });

  it('turns a typed name into a valid app name', () => {
    expect(slugName('My_Blog!')).toBe('my-blog');
    expect(first('deploy ghost as "news"')?.action).toMatchObject({ name: 'news' });
  });

  it('says nothing for templates it does not know or half a sentence', () => {
    expect(parseIntents('deploy nothing-like-it', world)).toEqual([]);
    expect(parseIntents('deploy ghost as', world)).toEqual([]);
  });
});
