import { describe, expect, it } from 'bun:test';
import { classifyServiceWithIntent, type ClassifiableService } from './exposure.service';
import { EXPOSURE_DRIFT_SIGNAL, planDriftAlerts } from './exposure-drift-alerts';

function svc(over: Partial<ClassifiableService> = {}): ClassifiableService {
  return { id: 'svc-1', name: 'web', stack: 'shop', labels: {}, ports: [], ...over };
}

const row = (over: Partial<ClassifiableService>, driver: string | null = 'caddy') =>
  classifyServiceWithIntent(svc(over), driver);

describe('planDriftAlerts — the Exposure page verdicts, as alert events', () => {
  it('declared private but publishing a port → one critical event with the page message + fix', () => {
    const plan = planDriftAlerts(
      [row({ name: 'db', labels: { 'swarmy.expose': 'private' }, ports: [{ target: 5432, published: 5432, protocol: 'tcp' }] })],
      new Set(),
    );
    expect(plan.fire).toEqual([
      {
        signal: EXPOSURE_DRIFT_SIGNAL,
        severity: 'critical',
        resource: 'shop/db',
        message:
          'db is declared private but publishes :5432/tcp to the world. Remove the public surface from db, or change its declared mode from "private" if the exposure is intended.',
      },
    ]);
    expect(plan.resolve).toEqual([]);
    expect([...plan.firing]).toEqual(['shop/db']);
  });

  it('declared public but unreachable → warning; undeclared and conforming services stay quiet', () => {
    const plan = planDriftAlerts(
      [
        row({ name: 'site', labels: { 'swarmy.expose': 'public' } }),
        row({ name: 'api', ports: [{ target: 80, published: 80, protocol: 'tcp' }] }),
        row({ name: 'worker', labels: { 'swarmy.expose': 'mesh' } }),
      ],
      new Set(),
    );
    expect(plan.fire.map((f) => [f.resource, f.severity])).toEqual([['shop/site', 'warning']]);
  });

  it('a leftover route on a private service is a warning — the edge withholds it', () => {
    const plan = planDriftAlerts(
      [row({ labels: { 'swarmy.expose': 'private', 'swarmy.ingress.routes': JSON.stringify([{ host: 'a.io', port: 80 }]) } })],
      new Set(),
    );
    expect(plan.fire[0]).toMatchObject({ severity: 'warning', resource: 'shop/web' });
    expect(plan.fire[0]!.message).toContain('withholds its route a.io');
  });

  it('resolves what drifted last tick and conforms now; keeps firing what still drifts', () => {
    const drifting = row({ name: 'db', labels: { 'swarmy.expose': 'mesh' }, ports: [{ target: 1, published: 9000, protocol: 'tcp' }] });
    const plan = planDriftAlerts([drifting, row({ name: 'web', labels: { 'swarmy.expose': 'mesh' } })], new Set(['shop/db', 'shop/web']));
    expect(plan.fire.map((f) => f.resource)).toEqual(['shop/db']);
    expect(plan.resolve).toEqual([
      {
        signal: EXPOSURE_DRIFT_SIGNAL,
        severity: 'info',
        resource: 'shop/web',
        message: 'shop/web matches its declared exposure again',
        status: 'resolved',
      },
    ]);
  });

  it('steady state: the same estate twice fires the same events and resolves nothing', () => {
    const rows = [row({ name: 'site', labels: { 'swarmy.expose': 'public' } })];
    const first = planDriftAlerts(rows, new Set());
    const second = planDriftAlerts(rows, first.firing);
    expect(second.fire).toEqual(first.fire);
    expect(second.resolve).toEqual([]);
  });
});
