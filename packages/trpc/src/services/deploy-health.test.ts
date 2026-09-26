import { describe, expect, it } from 'bun:test';
import { nextHealthEvents, type HealthMemo, type HealthSnapshot } from './deploy-health';
import { stepDoneLine, stepStage } from './blueprints/trace-steps';

const svc = (running: number) => [
  { name: 'blog_db', running: 1, desired: 1 },
  { name: 'blog_ghost', running, desired: 1 },
];
const domain = (state: string | null, over: Partial<NonNullable<HealthSnapshot['domain']>> = {}): HealthSnapshot['domain'] => ({
  host: 'blog.example.com',
  tls: 'auto',
  serving: true,
  state,
  certIssuer: null,
  certError: null,
  ...over,
});
const fresh: HealthMemo = { route: null, health: null };

/** Fold a run of snapshots, collecting every event line. */
function run(snaps: HealthSnapshot[]): { lines: string[]; live: boolean } {
  let memo = fresh;
  const lines: string[] = [];
  let live = false;
  for (const s of snaps) {
    const out = nextHealthEvents(memo, s);
    memo = out.memo;
    live = out.live;
    lines.push(...out.events.map((e) => `${e.stage}:${e.status} ${e.message}`));
  }
  return { lines, live };
}

describe('nextHealthEvents (route certificate + health check)', () => {
  it('route added → issuing → issued, then health once everything runs and the address answers', () => {
    const r = run([
      { services: svc(0), allVisible: true, domain: domain(null) },
      { services: svc(0), allVisible: true, domain: domain('issuing') },
      { services: svc(1), allVisible: true, domain: domain('issuing') },
      { services: svc(1), allVisible: true, domain: domain('active', { certIssuer: 'R11' }) },
    ]);
    expect(r.lines).toEqual([
      'route:started route https://blog.example.com added',
      'route:progress asking Let’s Encrypt for blog.example.com',
      'health:started checking 2/2 services running and blog.example.com',
      'route:done certificate for blog.example.com issued by R11',
      'health:done 2/2 services running · blog.example.com answering',
    ]);
    expect(r.live).toBe(true);
  });

  it('a steady state emits nothing', () => {
    const s: HealthSnapshot = { services: svc(0), allVisible: true, domain: domain('issuing') };
    const first = nextHealthEvents(fresh, s);
    expect(nextHealthEvents(first.memo, s).events).toEqual([]);
  });

  it('no address: live as soon as every service runs (no route events)', () => {
    const r = run([
      { services: svc(0), allVisible: true, domain: null },
      { services: svc(1), allVisible: true, domain: null },
    ]);
    expect(r.lines).toEqual(['health:started checking 2/2 services running', 'health:done 2/2 services running · it’s live']);
    expect(r.live).toBe(true);
  });

  it('a deploy pinned to a server names it in the health lines', () => {
    const r = run([{ services: svc(1), allVisible: true, domain: null, server: 'wkr-2' }]);
    expect(r.lines).toEqual(['health:started checking 2/2 services running on wkr-2', 'health:done 2/2 services running on wkr-2 · it’s live']);
  });

  it('never calls it live before every created service is visible', () => {
    expect(nextHealthEvents(fresh, { services: svc(1), allVisible: false, domain: null }).live).toBe(false);
  });

  it('a certificate error fails the route and holds health back; DNS waiting says so', () => {
    const r = run([
      { services: svc(1), allVisible: true, domain: domain('waiting_dns') },
      { services: svc(1), allVisible: true, domain: domain('error', { certError: 'rate limited' }) },
    ]);
    expect(r.lines).toContain('route:progress waiting for blog.example.com to point at your servers');
    expect(r.lines).toContain('route:failed certificate for blog.example.com: rate limited');
    expect(r.live).toBe(false);
  });

  it('plain HTTP needs no certificate', () => {
    const r = run([{ services: svc(1), allVisible: true, domain: domain(null, { tls: 'off' }) }]);
    expect(r.lines).toContain('route:done http://blog.example.com · plain HTTP, no certificate');
    expect(r.live).toBe(true);
  });
});

describe('blueprint steps → trace stages', () => {
  it('data steps are data, the stack is start, the route is route', () => {
    expect(['db.provision', 'cache.provision', 'bucket', 'secret'].map((k) => stepStage(k as never))).toEqual(['data', 'data', 'data', 'data']);
    expect(stepStage('stack.deploy')).toBe('start');
    expect(stepStage('ingress.route')).toBe('route');
  });

  it('a secret step says where the value went, never the value', () => {
    expect(stepDoneLine('secret', 'Generate secret blog-admin', 'Secret blog-admin created (v1, write-only)')).toBe(
      'secret blog-admin generated · stored as a Docker secret',
    );
    expect(stepDoneLine('db.provision', 'Create Postgres', 'Postgres cluster blog/db · host blog-db-rw')).toBe('Postgres cluster blog/db · host blog-db-rw');
  });
});
