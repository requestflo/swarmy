import { describe, expect, it } from 'bun:test';
import type { BlueprintMetaView } from '@swarmy/core';
import { categoryCounts, filterBlueprints } from './blueprint-filter';

const card = (id: string, category: BlueprintMetaView['category'], tagline: string): BlueprintMetaView => ({
  id,
  name: id,
  tagline,
  category,
  resources: ['App'],
  docOnly: false,
  supportsDomain: true,
  options: [],
});

const CARDS = [
  card('ghost', 'cms', 'Publishing for blogs'),
  card('umami', 'analytics', 'Privacy-friendly web analytics'),
  card('plausible', 'analytics', 'Simple web analytics'),
];

describe('blueprint gallery filter', () => {
  it('filters by category and by every query word', () => {
    expect(filterBlueprints(CARDS, '', 'analytics').map((c) => c.id)).toEqual(['umami', 'plausible']);
    expect(filterBlueprints(CARDS, 'web privacy', 'all').map((c) => c.id)).toEqual(['umami']);
    expect(filterBlueprints(CARDS, 'BLOG', 'all').map((c) => c.id)).toEqual(['ghost']);
    expect(filterBlueprints(CARDS, 'analytics', 'cms')).toEqual([]);
  });

  it('counts only categories with matches, in display order', () => {
    expect(categoryCounts(CARDS, '')).toEqual([
      { id: 'cms', label: 'CMS & blogs', count: 1 },
      { id: 'analytics', label: 'Analytics', count: 2 },
    ]);
    expect(categoryCounts(CARDS, 'simple')).toEqual([{ id: 'analytics', label: 'Analytics', count: 1 }]);
  });
});
