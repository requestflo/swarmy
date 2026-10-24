import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeExtList,
  normalizePreload,
  parseExtList,
  pgPreloadEnv,
  plannedRestartActive,
  preloadOf,
  withPreloadEnv,
} from './manageddb-extensions';
import { extMemberOf, extSignature, planPgExtensions, type ExtMember, type ExtPlanInput } from './manageddb-extensions-plan';
import { pgBootScript, pgPreloadLines } from './manageddb-pg';

const m = (service: string, phase: ExtMember['phase'], specPreload: string, over: Partial<ExtMember> = {}): ExtMember => ({
  service, phase, specPreload, desired: 1, running: 1, updating: false, verified: false, ...over,
});
const input = (over: Partial<ExtPlanInput>): ExtPlanInput => ({
  wanted: [], applied: [], failedFor: null, primaryRunning: true, writersRedeployable: true, members: [], ...over,
});

describe('label codecs', () => {
  it('keeps only catalog names, sorted and unique', () => {
    expect(parseExtList('postgis, pg_stat_statements,evil;drop,postgis')).toEqual(['pg_stat_statements', 'postgis']);
    expect(encodeExtList(['postgis', 'pg_stat_statements'])).toBe('pg_stat_statements,postgis');
  });
  it('only preload extensions reach shared_preload_libraries', () => {
    expect(preloadOf(['postgis'])).toBe('');
    expect(preloadOf(['postgis', 'pg_stat_statements'])).toBe('pg_stat_statements');
    expect(normalizePreload(' "pg_stat_statements" ')).toBe('pg_stat_statements');
    expect(pgPreloadEnv({ 'swarmy.db.extensions': 'pg_stat_statements' })).toEqual({ SWARMY_PG_PRELOAD: 'pg_stat_statements' });
    expect(withPreloadEnv({ A: '1', SWARMY_PG_PRELOAD: 'x' }, '')).toEqual({ A: '1' });
  });
  it('a planned restart holds for three minutes, then it is a real outage again', () => {
    const at = Date.parse('2026-10-24T10:00:00Z');
    const labels = { 'swarmy.db.restart.planned': '2026-10-24T10:00:00.000Z' };
    expect(plannedRestartActive(labels, at + 60_000)).toBe(true);
    expect(plannedRestartActive(labels, at + 4 * 60_000)).toBe(false);
    expect(plannedRestartActive(undefined, at)).toBe(false);
  });
});

describe('planPgExtensions — standbys first, then the writer in place, then CREATE', () => {
  const P = 'pg_stat_statements';
  it('steady when nothing is wanted or everything is applied (zero commands)', () => {
    expect(planPgExtensions(input({ members: [m('p', 'writer', '')] }))).toEqual({ kind: 'steady' });
    expect(planPgExtensions(input({ wanted: [P], applied: [P], members: [m('p', 'writer', P), m('r', 'standby', P)] }))).toEqual({ kind: 'steady' });
  });
  it('restarts standbys before the writer', () => {
    const step = planPgExtensions(input({ wanted: [P], members: [m('p', 'writer', ''), m('r', 'standby', ''), m('geo', 'standby', '')] }));
    expect(step).toEqual({ kind: 'restart', phase: 'standby', services: ['r', 'geo'], preload: P });
  });
  it('waits until every standby is back with the library loaded', () => {
    const members = [m('p', 'writer', ''), m('r', 'standby', P, { updating: true })];
    expect(planPgExtensions(input({ wanted: [P], members }))).toEqual({ kind: 'verify', phase: 'standby', services: ['r'], preload: P });
    members[1] = m('r', 'standby', P, { verified: true });
    expect(planPgExtensions(input({ wanted: [P], members }))).toEqual({ kind: 'restart', phase: 'writer', services: ['p'], preload: P });
  });
  it('a parked standby (0 tasks) gets the new spec but is not waited on', () => {
    const members = [m('p', 'writer', ''), m('r', 'standby', P, { desired: 0, running: 0 })];
    expect(planPgExtensions(input({ wanted: [P], members })).kind).toBe('restart');
  });
  it('never restarts a writer on temporary storage', () => {
    const step = planPgExtensions(input({ wanted: [P], writersRedeployable: false, members: [m('p', 'writer', '')] }));
    expect(step.kind).toBe('blocked');
  });
  it('creates only after the writer answers with the library loaded', () => {
    const members = [m('p', 'writer', P)];
    expect(planPgExtensions(input({ wanted: [P], members })).kind).toBe('verify');
    members[0] = m('p', 'writer', P, { verified: true });
    expect(planPgExtensions(input({ wanted: [P], members }))).toEqual({ kind: 'create', names: [P] });
  });
  it('postgis needs no restart: straight to CREATE', () => {
    expect(planPgExtensions(input({ wanted: ['postgis'], members: [m('p', 'writer', '')] }))).toEqual({ kind: 'create', names: ['postgis'] });
  });
  it('a failed CREATE is not retried until the wanted set changes', () => {
    const members = [m('p', 'writer', '')];
    expect(planPgExtensions(input({ wanted: ['postgis'], failedFor: 'postgis', members })).kind).toBe('blocked');
    expect(planPgExtensions(input({ wanted: ['postgis'], failedFor: 'pg_stat_statements', members })).kind).toBe('create');
  });
  it('turning off drops the extension first, while its library is still loaded', () => {
    const members = [m('p', 'writer', P), m('r', 'standby', P)];
    expect(planPgExtensions(input({ applied: [P], members }))).toEqual({ kind: 'drop', names: [P] });
    expect(planPgExtensions(input({ members }))).toEqual({ kind: 'restart', phase: 'standby', services: ['r'], preload: '' });
  });
  it('reads a live service and signs everything but verification', () => {
    const svc = { name: 'p', labels: {}, env: ['SWARMY_PG_PRELOAD=pg_stat_statements'], runningReplicas: 1, updateStatus: 'updating' };
    const mem = extMemberOf(svc, 'writer', false);
    expect(mem).toEqual({ service: 'p', phase: 'writer', specPreload: P, desired: 1, running: 1, updating: true, verified: false });
    expect(extSignature(input({ members: [mem] }))).toBe(extSignature(input({ members: [{ ...mem, verified: true }] })));
  });
});

describe('boot layer — SWARMY_PG_PRELOAD → shared_preload_libraries', () => {
  const run = (env: Record<string, string>) => {
    const conf = join(mkdtempSync(join(tmpdir(), 'swarmy-preload-')), 'swarmy-preload.conf');
    const script = ['log() { :; }', ...pgPreloadLines(conf)].join('\n');
    Bun.spawnSync(['sh', '-c', script], { env: { PATH: process.env.PATH ?? '', ...env } });
    return existsSync(conf) ? readFileSync(conf, 'utf8') : null;
  };
  it('writes the library list on start', () => {
    expect(run({ SWARMY_PG_PRELOAD: 'pg_stat_statements' })).toBe("shared_preload_libraries = 'pg_stat_statements'\n");
  });
  it('writes nothing without it, and ignores anything but a plain list', () => {
    expect(run({})).toBeNull();
    expect(run({ SWARMY_PG_PRELOAD: "x'; DROP" })).toBeNull();
  });
  it('the entrypoint runs it before handing off to the official one', () => {
    const s = pgBootScript();
    expect(s.indexOf('SWARMY_PG_PRELOAD')).toBeGreaterThan(0);
    expect(s.indexOf('SWARMY_PG_PRELOAD')).toBeLessThan(s.indexOf('exec docker-entrypoint.sh postgres'));
  });
});
