import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { getIngressSettings, updateIngressSettings } from './ingress-settings.service';
import { setAutoAddressBase, setTunnel } from './ingress-setters';
import { world, type WorldOpts } from './ingress-settings-testing';

/** Run a write that must be refused, and prove nothing moved: no command, no save, no audit row. */
async function refused(patch: unknown, opts: WorldOpts = {}, write = updateIngressSettings): Promise<TRPCError> {
  const w = world(opts);
  const before = JSON.stringify(w.doc());
  const err = await write(w.ctx, patch as never).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TRPCError);
  expect(w.sent.filter((s) => s.cmd !== 'secret.list')).toEqual([]);
  expect(JSON.stringify(w.doc())).toBe(before);
  expect(w.audit).toEqual([]);
  return err as TRPCError;
}

const fieldErrors = (e: TRPCError) => (e.cause as unknown as { fieldErrors: Array<{ field: string; message: string }> }).fieldErrors;

describe('updateIngressSettings — one invalid field leaves everything unchanged', () => {
  it('a bad tunnel token beside valid fields refuses the whole patch', async () => {
    const e = await refused({ enabled: false, controllerImage: 'x:1', tunnel: { runToken: 'x'.repeat(40) } });
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).toMatch(/Cloudflare tunnel token/);
    expect(fieldErrors(e).map((f) => f.field)).toEqual(['tunnel.runToken']);
  });

  it('names every refused field, schema and rule alike, with each reason', async () => {
    const e = await refused({
      enabled: true,
      driver: 'traefik',
      colour: 'blue',
      tls: { onDemand: true },
      geoip: { mode: 'file' },
      autoAddressBase: 'not a domain',
    });
    expect(fieldErrors(e).map((f) => f.field)).toEqual(['driver', 'colour', 'tls.onDemand', 'geoip.path', 'autoAddressBase']);
    expect(e.message).toStartWith('invalid ingress settings: ');
    for (const f of fieldErrors(e)) expect(e.message).toContain(`${f.field}: ${f.message}`);
  });

  it('a patch whose only fields are invalid is refused, not an empty no-op', async () => {
    const e = await refused({ colour: 'blue' });
    expect(fieldErrors(e)).toEqual([{ field: 'colour', message: 'Not an ingress setting' }]);
  });

  it('on-demand TLS with neither an email nor an ask endpoint keeps its plain sentence', async () => {
    const e = await refused({ tls: { onDemand: true } });
    expect(e.message).toBe('on-demand TLS requires an ACME email or an ask endpoint');
  });

  it('keeps the last-edge rule: no ingress node, no edge-per-node', async () => {
    const e = await refused({ topology: 'edge-per-node', controllerImage: 'x:1' }, { ingressNode: false });
    expect(e.message).toMatch(/No node is marked as an ingress node/);
  });
});

describe('the per-field setters ride the same checks', () => {
  it('setTunnel and setAutoAddressBase refuse exactly as the patch does', async () => {
    const t = await refused({ runToken: 'x'.repeat(40) }, {}, setTunnel as never);
    expect(fieldErrors(t).map((f) => f.field)).toEqual(['tunnel.runToken']);
    const b = await refused('not a domain', {}, setAutoAddressBase as never);
    expect(b.message).toMatch(/not a domain name/);
  });

  it('the read is unchanged after a refusal', async () => {
    const w = world();
    const before = await getIngressSettings(w.ctx);
    await expect(updateIngressSettings(w.ctx, { geoip: { mode: 'file' }, enabled: false })).rejects.toThrow(/file path is required/);
    expect(await getIngressSettings(w.ctx)).toEqual(before);
  });
});
