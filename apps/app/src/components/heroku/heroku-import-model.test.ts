import { describe, expect, it } from 'bun:test';
import { herokuImport } from '@/demo/resolvers/heroku-import';
import type { DemoStore } from '@/demo/types';
import { deploySentence, HEROKU_SAMPLE, toSource } from './heroku-import-model';
import { EMPTY_DRAFT, type HerokuDeployResult, type HerokuImportView } from './heroku-types';

const store = {} as DemoStore;
const call = <T,>(name: string, input: unknown): T => herokuImport.handlers![name]!(input, store) as T;

describe('Import from Heroku: the form and the plan', () => {
  it('the form → a source, or the first thing to fix', () => {
    expect(toSource({ ...EMPTY_DRAFT, token: 'HRKU-0123456789', app: 'Acme-Shop' })).toEqual({ source: { kind: 'api', token: 'HRKU-0123456789', app: 'acme-shop' } });
    expect(toSource({ ...EMPTY_DRAFT, token: 'short', app: 'acme' })).toEqual({ error: 'paste the whole token' });
    expect(toSource({ ...EMPTY_DRAFT, token: 'HRKU-0123456789', app: 'no spaces' })).toEqual({ error: 'a Heroku app name like acme-shop' });
    expect(toSource({ ...EMPTY_DRAFT, kind: 'paste' })).toEqual({ error: 'Paste the Procfile, app.json or both.' });
    expect(toSource({ ...EMPTY_DRAFT, kind: 'paste', ...HEROKU_SAMPLE })).toMatchObject({ source: { kind: 'paste', domains: 'shop.example.com' } });
  });

  it('the sample converts cleanly and Deploy says what it will do', () => {
    const src = toSource({ ...EMPTY_DRAFT, kind: 'paste', ...HEROKU_SAMPLE });
    if (!('source' in src)) throw new Error(src.error);
    const v = call<HerokuImportView>('herokuImport.plan', { source: src.source });
    expect(v).toMatchObject({ app: 'shop-classic', valid: true, copyable: ['db'], sealable: ['secret-key-base'] });
    expect(v.plan.headline).toBe('shop-classic comes across as 2 services, a Postgres database and a cache.');
    expect(deploySentence(v)).toBe('Deploy starts db and cache and seals 1 secret with Heroku’s values. Your 2 services deploy when swarmy.yaml lands in your repo.');
    for (const leaked of ['password@', 'replace-me']) expect(JSON.stringify(v)).not.toContain(leaked);
  });

  it('the demo’s token path reads northwind’s app; Deploy and the copy answer like the controller', () => {
    const source = { kind: 'api', token: 'HRKU-demo-token', app: 'shop-classic' };
    const v = call<HerokuImportView>('herokuImport.plan', { source });
    expect(v.plan.domains).toEqual(['shop.northwind.dev']);
    const d = call<HerokuDeployResult>('herokuImport.deploy', { source, stack: v.app });
    expect(d.steps.map((s) => `${s.key}:${s.status}`)).toEqual(['resources.db:created', 'resources.cache:created', 'secrets.secret-key-base:created', 'secrets.papertrail-api-token:created']);
    expect(() => call('herokuImport.copyDatabase', { source, stack: 'shop-classic', cluster: 'db', confirm: 'db' })).toThrow('Type shop-classic/db to copy the data.');
    expect(call<{ status: string }>('herokuImport.copyDatabase', { source, stack: 'shop-classic', cluster: 'db', confirm: 'shop-classic/db' }).status).toBe('copied');
  });
});
