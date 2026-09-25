import { describe, expect, test } from 'bun:test';
import { brokenOverlayNetworks, overlayHealPlan, renderCarrierProbe, type OverlayContainer, type OverlayNetwork } from './overlay-heal';

// The exact state captured on the Lima repro of QA-066 (b): after a dockerd
// restart plus a crash-looping task, both tasks on the node lost carrier on
// both overlays, and so did both LB sandboxes.
const OVERLAYS: OverlayNetwork[] = [
  { id: '1pnl2r25n3r3tch0iyut3dggc', name: 'ingress' },
  { id: 'clkqok2k5agyphv06pucu2e55', name: 'swarmy' },
  { id: 'nhyh7smrwwbzwtswlzpfpgkda', name: 'swarmy-control' },
];
const web: OverlayContainer = {
  id: 'a'.repeat(64),
  pid: 5299,
  task: true,
  networks: {
    swarmy: { networkId: 'clkqok2k5agyphv06pucu2e55', mac: '02:42:0a:d2:01:03', aliases: ['aaaaaaaaaaaa'] },
    'swarmy-control': { networkId: 'nhyh7smrwwbzwtswlzpfpgkda', mac: '02:42:0a:d2:02:03', aliases: [] },
  },
};
const garage: OverlayContainer = {
  id: 'b'.repeat(64),
  pid: 5291,
  task: true,
  networks: {
    swarmy: { networkId: 'clkqok2k5agyphv06pucu2e55', mac: '02:42:0a:d2:01:04', aliases: [] },
    'swarmy-control': { networkId: 'nhyh7smrwwbzwtswlzpfpgkda', mac: '02:42:0a:d2:02:04', aliases: [] },
  },
};
const agent: OverlayContainer = {
  id: 'c'.repeat(64),
  pid: 4000,
  task: false,
  networks: { 'swarmy-control': { networkId: 'nhyh7smrwwbzwtswlzpfpgkda', mac: '02:42:0a:d2:02:09', aliases: ['cccccccccccc', 'swarmy-agent-lon1a'] } },
};
const BROKEN_PROBE = [
  'PID 5299 02:42:0a:d2:02:03',
  'PID 5299 02:42:0a:d2:01:03',
  'PID 5291 02:42:0a:d2:02:04',
  'PID 5291 02:42:0a:d2:01:04',
  'LB clkqok2k5',
  'LB nhyh7smrw',
  '',
].join('\n');

describe('overlay carrier heal (QA-066 b: endpoints orphaned by dockerd)', () => {
  test('finds both overlays from the captured broken state', () => {
    expect(brokenOverlayNetworks(BROKEN_PROBE, [web, garage], OVERLAYS)).toEqual(['swarmy', 'swarmy-control']);
  });

  test('an LB sandbox alone is enough (the VIP is dead even when tasks were recycled)', () => {
    expect(brokenOverlayNetworks('LB clkqok2k5\n', [web], OVERLAYS)).toEqual(['swarmy']);
  });

  test('healthy, docker0-only and unknown links are ignored; ingress is never a target', () => {
    expect(brokenOverlayNetworks('', [web, garage], OVERLAYS)).toEqual([]);
    expect(brokenOverlayNetworks('PID 5299 02:42:ac:11:00:02\nPID 1 02:42:0a:d2:01:03\n', [web], OVERLAYS)).toEqual([]);
    expect(brokenOverlayNetworks('LB 1pnl2r25n\n', [web], OVERLAYS)).toEqual([]);
    expect(brokenOverlayNetworks('LB x\n', [web], OVERLAYS)).toEqual([]);
  });

  test('the plan: every task on a broken network re-created, other attachments cycled with their aliases', () => {
    const plan = overlayHealPlan(['swarmy-control'], [web, garage, agent], agent.id);
    expect(plan.remove).toEqual([web.id, garage.id].sort());
    // The container id alias is Docker's own; the agent's name alias is kept.
    expect(plan.disconnect).toEqual([{ id: agent.id, network: 'swarmy-control', aliases: ['swarmy-agent-lon1a'] }]);
  });

  test('a container on no broken network is left alone; the agent itself is never removed', () => {
    const plan = overlayHealPlan(['swarmy'], [agent, { ...web, id: 'd'.repeat(64) }], 'd'.repeat(64));
    expect(plan.remove).toEqual([]);
    expect(plan.disconnect.map((x) => x.id)).toEqual(['d'.repeat(64)]);
  });

  test('the probe script only takes numeric pids', () => {
    const s = renderCarrierProbe([5299, -1, 0, 1.5, 5291]);
    expect(s).toContain('for p in 5299 5291; do');
    expect(s).toContain('/var/run/docker/netns/lb_*');
  });
});
