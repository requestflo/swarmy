import { afterEach, describe, expect, it } from 'bun:test';
import type { ProbeSmtpResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../../context';
import { listPort25Servers, resetPort25Servers, testPort25Servers } from './port25-servers';

/**
 * Board 66's per-server port-25 test: every online server whose agent
 * advertised `probeSmtp` is asked once; the rest say why they weren't.
 * Against an in-memory hub.
 */

const OPEN: ProbeSmtpResult = { reachable: true, attempts: [{ host: 'gmail-smtp-in.l.google.com', port: 25, ok: true, ms: 84, banner: '220 mx.google.com' }] };
const DROPPED: ProbeSmtpResult = { reachable: false, attempts: [{ host: 'gmail-smtp-in.l.google.com', port: 25, ok: false, ms: 5000, error: { kind: 'timeout', message: 'no answer' } }] };

function world() {
  const nodes = [
    { id: 'n-ams', name: 'ams-1' },
    { id: 'n-do', name: 'do-1' },
    { id: 'n-old', name: 'old-1' },
    { id: 'n-off', name: 'off-1' },
  ];
  const asked: string[] = [];
  const audits: Array<{ action: string; metadata?: unknown }> = [];
  const hub = {
    isOnline: (id: string) => id !== 'n-off',
    agentBuildFor: (id: string) => ({ version: '1', ...(id === 'n-old' ? {} : { capabilities: ['probeSmtp'] }) }),
    dispatch: async (id: string, cmd: string, payload: { targets: unknown[]; perTargetMs: number }) => {
      asked.push(`${id}:${cmd}:${payload.targets.length}:${payload.perTargetMs}`);
      return id === 'n-ams' ? OPEN : DROPPED;
    },
  };
  const db = {
    node: { findMany: async () => nodes },
    auditLog: { create: async ({ data }: { data: { action: string; metadata?: unknown } }) => void audits.push(data) },
  };
  const ctx = { db, hub, user: { id: 'u1' }, activeOrgId: 'org-p25' } as unknown as OrgContext;
  return { ctx, asked, audits };
}

afterEach(resetPort25Servers);

describe('per-server port-25 test', () => {
  it('before any test, says why each server has no result', async () => {
    const rows = await listPort25Servers(world().ctx);
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['ams-1', 'untested'],
      ['do-1', 'untested'],
      ['old-1', 'unsupported'],
      ['off-1', 'offline'],
    ]);
  });

  it('asks only online servers with the capability, one MX, a short budget; audits once', async () => {
    const w = world();
    const rows = await testPort25Servers(w.ctx);
    expect(w.asked.sort()).toEqual(['n-ams:email.probeSmtp:1:5000', 'n-do:email.probeSmtp:1:5000']);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by['ams-1']).toMatchObject({ state: 'open', target: 'gmail-smtp-in.l.google.com:25', ms: 84 });
    expect(by['do-1']?.state).toBe('timeout');
    expect(by['do-1']?.words).toContain('use a relay');
    expect(by['old-1']?.state).toBe('unsupported');
    expect(w.audits).toEqual([expect.objectContaining({ action: 'email.port25.servers', metadata: { tested: 2, open: 1, blocked: 0, timeout: 1 } })]);
  });

  it('keeps the results for the next read', async () => {
    const w = world();
    await testPort25Servers(w.ctx);
    const again = await listPort25Servers(w.ctx);
    expect(again.find((r) => r.name === 'ams-1')?.state).toBe('open');
  });
});
