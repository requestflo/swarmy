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

  it('applies the quick toggles', () => {
    const cards: BlueprintMetaView[] = [
      { ...card('ghost', 'cms', 'Blog'), heavy: true, minMemoryMb: 1152 },
      { ...card('umami', 'analytics', 'Stats'), managed: ['postgres'], minMemoryMb: 640 },
      { ...card('kuma', 'monitoring', 'Uptime'), minMemoryMb: 256 },
    ];
    expect(filterBlueprints(cards, '', 'all', { small: true }).map((c) => c.id)).toEqual(['umami', 'kuma']);
    expect(filterBlueprints(cards, '', 'all', { postgres: true }).map((c) => c.id)).toEqual(['umami']);
    expect(filterBlueprints(cards, '', 'all', { light: true }).map((c) => c.id)).toEqual(['kuma']);
    expect(categoryCounts(cards, '', { light: true })).toEqual([{ id: 'monitoring', label: 'Monitoring', count: 1 }]);
  });
});
