import { describe, expect, it } from 'bun:test';
import {
  DB_INJECT_HOST_LABEL,
  DB_INJECT_RO_HOST_LABEL,
  appRepointMessage,
  appRepointSignature,
  planAppRepoint,
  startFirstAllowed,
  type RepointStandby,
} from './manageddb-app-repoint';

/**
 * Apps follow the writer: which apps the promotion pass re-mints, which it
 * leaves alone, where their read-only URL goes, and that a second tick (or a
 * pass a restart cut short) only does what is left.
 */

const P = 'shop_main-primary';
const R = 'shop_main-replica';
const EU = 'shop_main-replica-eu';

const app = (name: string, labels: Record<string, string> = {}) => ({
  name,
  labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.inject': 'main', ...labels },
});
const direct = (name: string, rw = P, ro = R, extra: Record<string, string> = {}) =>
  app(name, { [DB_INJECT_HOST_LABEL]: rw, [DB_INJECT_RO_HOST_LABEL]: ro, ...extra });

// R was promoted; the old writer P is down, the EU sibling runs.
const STANDBYS: RepointStandby[] = [
  { service: P, running: 0 },
  { service: EU, running: 1, region: 'eu' },
];
const plan = (services: Array<ReturnType<typeof app>>, standbys = STANDBYS, writer = R) =>
  planAppRepoint({ stack: 'shop', cluster: 'main', writer, standbys, services });

describe('planAppRepoint — who is re-minted', () => {
  it('an app whose URL names the old writer moves to the new one', () => {
    expect(plan([direct('shop_api')]).moves).toEqual([{ service: 'shop_api', envVar: 'DATABASE_URL', from: P, roFrom: R, ro: EU }]);
  });

  it('through the pooler: untouched (the pooler follows the writer)', () => {
    const p = plan([app('shop_web', { 'swarmy.db.inject.via': 'pooler' }), direct('shop_api')]);
    expect(p.pooled).toEqual(['shop_web']);
    expect(p.moves.map((m) => m.service)).toEqual(['shop_api']);
  });

  it('apps of other clusters or stacks, and the cluster’s own members, are not apps of this cluster', () => {
    const other = app('shop_cache', { 'swarmy.db.inject': 'other' });
    const elsewhere = { name: 'blog_api', labels: { 'com.docker.stack.namespace': 'blog', 'swarmy.db.inject': 'main' } };
    const member = app(P, { 'swarmy.db.cluster': 'main' });
    expect(plan([other, elsewhere, member])).toEqual({ writer: R, moves: [], steady: [], pooled: [] });
  });

  it('wired before the host labels: it names the base primary, as connect always did', () => {
    expect(plan([app('shop_api', { 'swarmy.db.inject.var': 'PG_URL' })]).moves).toEqual([
      { service: 'shop_api', envVar: 'PG_URL', from: P, roFrom: R, ro: EU },
    ]);
    // …and while the base primary is still the writer, it is steady (no restart on upgrade).
    expect(plan([app('shop_api')], [{ service: R, running: 1 }], P)).toMatchObject({ moves: [], steady: ['shop_api'] });
  });
});

describe('planAppRepoint — the read-only URL', () => {
  it('one that named the promoted copy goes to a running standby, the base one first', () => {
    const both = [{ service: 'shop_main-replica-ap', running: 1, region: 'ap' }, { service: 'shop_main-replica-2', running: 1 }, ...STANDBYS];
    expect(plan([direct('shop_api', P, R)], both).moves[0]!.ro).toBe('shop_main-replica-2');
  });

  it('…or to the writer when no standby runs (the old writer is still down)', () => {
    expect(plan([direct('shop_api', P, R)], [{ service: P, running: 0 }]).moves[0]!.ro).toBe(R);
  });

  it('one on a standby that still runs stays there', () => {
    expect(plan([direct('shop_api', P, EU)]).moves[0]).toMatchObject({ roFrom: EU, ro: EU });
  });

  it('one on a copy that is down (the old writer) moves too', () => {
    expect(plan([direct('shop_api', P, P)]).moves[0]).toMatchObject({ roFrom: P, ro: EU });
  });
});

describe('planAppRepoint — idempotent and resumable', () => {
  it('a second tick, once the app names the writer: nothing to do', () => {
    const after = plan([direct('shop_api', R, EU)]);
    expect(after).toEqual({ writer: R, moves: [], steady: ['shop_api'], pooled: [] });
  });

  it('a pass cut short: only the app still on the old writer moves', () => {
    const p = plan([direct('shop_api', R, EU), direct('shop_worker', P, R)]);
    expect(p.steady).toEqual(['shop_api']);
    expect(p.moves.map((m) => m.service)).toEqual(['shop_worker']);
  });

  it('the signature changes only with what would move', () => {
    const a = appRepointSignature(plan([direct('shop_api'), direct('shop_worker')]));
    expect(appRepointSignature(plan([direct('shop_worker'), direct('shop_api')]))).toBe(a);
    expect(appRepointSignature(plan([direct('shop_api')]))).not.toBe(a);
    expect(a).toBe(`${R}|shop_api>${EU},shop_worker>${EU}`);
  });

  it('says it the way the timeline does', () => {
    expect(appRepointMessage({ service: 'shop_api' }, 'shop_main-replica')).toBe('Repointed shop_api at shop_main-replica');
  });
});

describe('startFirstAllowed — rolling where the app allows', () => {
  it('a stateless app starts its new task first', () => {
    expect(startFirstAllowed({})).toBe(true);
    expect(startFirstAllowed({ ports: [{ mode: 'ingress', published: 8080 }], mounts: [{ type: 'tmpfs' }, { type: 'bind', readOnly: true }] })).toBe(true);
  });

  it('a host-mode published port or a writable mount keeps the stop-first order', () => {
    expect(startFirstAllowed({ ports: [{ mode: 'host', published: 80 }] })).toBe(false);
    expect(startFirstAllowed({ mounts: [{ type: 'volume' }] })).toBe(false);
    expect(startFirstAllowed({ mounts: [{ type: 'bind', readOnly: false }] })).toBe(false);
  });
});
