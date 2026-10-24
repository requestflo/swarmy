import { describe, expect, it } from 'bun:test';
import { setSearchIndexSettings, settingsBody } from './search-index-settings.service';
import { ctxWith } from './search-testing';

const ref = { stack: 'shop', name: 'main', index: 'products' };

describe('settingsBody — only the lists given', () => {
  it('an empty searchable list means every field; filters are trimmed and de-duplicated', () => {
    expect(settingsBody({ ...ref, searchable: [], filterable: [' price', 'price', 'in_stock'] })).toEqual({
      body: { searchableAttributes: ['*'], filterableAttributes: ['price', 'in_stock'] },
      changed: ['searchable', 'filterable'],
    });
    expect(settingsBody({ ...ref, synonyms: { mug: ['cup'] } })).toEqual({ body: { synonyms: { mug: ['cup'] } }, changed: ['synonyms'] });
  });
});

describe('setSearchIndexSettings', () => {
  it('PATCHes inside the engine with the body as $1, waits for the task, audits once', async () => {
    const { ctx, audit, sent } = ctxWith('owner', () => [
      [202, { taskUid: 41, indexUid: 'products', status: 'enqueued' }],
      [200, { uid: 41, status: 'succeeded', error: null }],
    ]);
    const r = await setSearchIndexSettings(ctx, { ...ref, filterable: ['category', 'price'] });
    const cmd = sent[0]!.payload.cmd;
    expect(cmd[2]).toContain('-X PATCH');
    expect(cmd[2]).not.toContain('category');
    expect(JSON.parse(cmd[4]!)).toEqual({ filterableAttributes: ['category', 'price'] });
    expect(r).toEqual({ index: 'products', taskUid: 41, status: 'succeeded', error: null, changed: ['filterable'] });
    expect(audit.map((a) => a.action)).toEqual(['search.index.settings']);
    expect(audit[0]!.metadata).toMatchObject({ index: 'products', changed: ['filterable'], status: 'succeeded' });
  });

  it('a task still running answers "processing" — the engine keeps going', async () => {
    const { ctx } = ctxWith('owner', () => [
      [202, { taskUid: 7, status: 'enqueued' }],
      [200, { uid: 7, status: 'processing' }],
    ]);
    expect((await setSearchIndexSettings(ctx, { ...ref, searchable: ['title'] })).status).toBe('processing');
  });

  it('a failed task is refused with the engine’s reason, and still audited', async () => {
    const { ctx, audit } = ctxWith('owner', () => [
      [202, { taskUid: 8, status: 'enqueued' }],
      [200, { uid: 8, status: 'failed', error: { message: 'Attribute `pricee` is not filterable.' } }],
    ]);
    await expect(setSearchIndexSettings(ctx, { ...ref, filterable: ['pricee'] })).rejects.toThrow('pricee');
    expect(audit[0]!.metadata).toMatchObject({ status: 'failed' });
  });

  it('nothing to change is refused before the engine is asked', async () => {
    const { ctx, sent } = ctxWith('owner', () => []);
    await expect(setSearchIndexSettings(ctx, ref)).rejects.toThrow('nothing to change');
    expect(sent).toHaveLength(0);
  });
});
