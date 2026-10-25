import { describe, expect, it } from 'bun:test';
import { routeDriverPlan } from './route-driver-model';

const values = (p: ReturnType<typeof routeDriverPlan>) => p.choices.map((c) => c.value);

describe('routeDriverPlan — only the front doors this org can run', () => {
  it('a Caddy org without a tunnel offers its front door or leaving it to you', () => {
    const p = routeDriverPlan({ orgDriver: 'caddy', tunnelConfigured: false });
    expect(values(p)).toEqual([null, 'none']);
    expect(p.current).toBeNull();
    expect(p.choices[0]!.label).toBe('The front door');
  });

  it('a connected tunnel adds it as a choice', () => {
    const p = routeDriverPlan({ orgDriver: 'caddy', tunnelConfigured: true, routeDriver: 'cloudflared' });
    expect(values(p)).toEqual([null, 'cloudflared', 'none']);
    expect(p.current).toBe('cloudflared');
    expect(p.choices.every((c) => c.available)).toBe(true);
  });

  it('a route already on a tunnel that is gone keeps showing it, unavailable', () => {
    const p = routeDriverPlan({ orgDriver: 'caddy', tunnelConfigured: false, routeDriver: 'cloudflared' });
    expect(values(p)).toEqual([null, 'cloudflared', 'none']);
    expect(p.choices[1]).toMatchObject({ available: false, say: expect.stringMatching(/No tunnel is connected/) });
  });

  it('a tunnel org never offers the tunnel twice; asking for the org’s own driver is no override', () => {
    const p = routeDriverPlan({ orgDriver: 'cloudflared', tunnelConfigured: true, routeDriver: 'cloudflared' });
    expect(values(p)).toEqual([null, 'none']);
    expect(p.current).toBeNull();
    expect(p.choices[0]!.label).toBe('Your Cloudflare Tunnel');
  });

  it('an org on its own proxy has nothing to pick; legacy drivers read as the org’s', () => {
    expect(values(routeDriverPlan({ orgDriver: 'none', tunnelConfigured: false }))).toEqual([null]);
    expect(routeDriverPlan({ orgDriver: 'caddy', tunnelConfigured: false, routeDriver: 'traefik' }).current).toBeNull();
  });

  it('the app’s declared exposure decides for every address', () => {
    expect(routeDriverPlan({ orgDriver: 'caddy', tunnelConfigured: true, expose: 'private' }).locked).toMatch(/private network/);
    const t = routeDriverPlan({ orgDriver: 'caddy', tunnelConfigured: true, expose: 'tunnel' });
    expect(t.locked).toMatch(/Cloudflare Tunnel/);
    expect(t.choices).toEqual([]);
    expect(routeDriverPlan({ orgDriver: 'caddy', tunnelConfigured: true, expose: 'public' }).locked).toBeNull();
  });
});
