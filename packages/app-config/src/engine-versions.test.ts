import { describe, expect, it } from 'bun:test';
import { dataImageFor, offeredMajors } from '@swarmy/core/data-images';
import { CACHE_ENGINES, SEARCH_ENGINES } from '@swarmy/core/views';
import { DEFAULT_POSTGRES_VERSION, POSTGRES_VERSIONS } from './schema';

// What swarmy.yaml lets an app pick must be what the BOM's data section carries:
// a version the BOM lacks would deploy an image no release pins and no offline bundle has.
describe('swarmy.yaml engine choices = the BOM data section', () => {
  it('offers exactly the Postgres majors the BOM has an image for', () => {
    expect(POSTGRES_VERSIONS.map(String)).toEqual(offeredMajors('postgres'));
    expect(offeredMajors('postgres')).toContain(String(DEFAULT_POSTGRES_VERSION));
  });

  it('every cache and search engine has a BOM image', () => {
    for (const e of [...CACHE_ENGINES, ...SEARCH_ENGINES]) expect(dataImageFor(e)).toBeDefined();
  });
});
