import { describe, expect, test } from 'bun:test';
import { engineSwitch } from './search-switch-words';

describe('engineSwitch (board 41: what a switch would take)', () => {
  test('Meilisearch → Typesense: a new instance, a copy, a partial settings map, and the app’s code', () => {
    const s = engineSwitch('meilisearch', 'web');
    expect(s.to).toBe('Typesense');
    expect(s.steps.map((x) => x.head)).toEqual(['A new Typesense instance', 'Every document copied across', 'Settings mapped, where they map', 'web’s search code']);
    expect(s.steps[2]!.body).toContain('query_by');
    expect(s.steps[3]!.body).toBe('Meilisearch and Typesense have different APIs and clients, so web moves from MEILI_HOST to TYPESENSE_HOST and its search calls change. swarmy can’t make that change.');
    expect(s.move).toMatch(/^So swarmy doesn’t switch engines for you\./);
  });

  test('Typesense → Meilisearch, with no app attached yet', () => {
    const s = engineSwitch('typesense', null);
    expect(s.to).toBe('Meilisearch');
    expect(s.steps[3]!.head).toBe('your app’s search code');
    expect(s.steps[3]!.body).toContain('from TYPESENSE_HOST to MEILI_HOST');
  });
});
