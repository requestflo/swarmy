import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MESH_CONTROL_PRIVATE_PORTS } from '@swarmy/mesh';
import { MESH_FIREWALL_PORTS, renderMeshFirewallScript } from './mesh-firewall';

const rulesOf = (script: string) => script.match(/rules="([\s\S]*?)"/)![1]!.trim();

describe('mesh control-plane firewall (QA-014)', () => {
  test('drops metrics / legacy gRPC / health off-host, keeps loopback, Docker and the mesh', () => {
    const r = rulesOf(renderMeshFirewallScript());
    expect(r.split('\n')).toEqual([
      '-i lo -j RETURN',
      '-i docker0 -j RETURN',
      '-i docker_gwbridge -j RETURN',
      '-i br-+ -j RETURN',
      '-i wt0 -j RETURN',
      '-p tcp -m multiport --dports 9000,9090,33073 -j DROP',
    ]);
    // Never the public ones.
    for (const p of [443, 80, 8081, 3478]) expect(r).not.toContain(String(p) + ',');
  });
  test('covers exactly the ports the server config declares private', () => {
    expect([...MESH_FIREWALL_PORTS].sort()).toEqual([...MESH_CONTROL_PRIVATE_PORTS].sort());
  });
  test('ports are validated before reaching the shell', () => {
    expect(rulesOf(renderMeshFirewallScript([9090, 0, 70000, 1.5 as number]))).toContain('--dports 9090 ');
  });
  test('the installer applies the same rules before the agent exists', () => {
    const sh = readFileSync(join(import.meta.dir, '../../../../scripts/install-swarmy.sh'), 'utf8');
    const block = sh.slice(sh.indexOf('mesh_control_firewall() {'));
    expect(rulesOf(block)).toBe(rulesOf(renderMeshFirewallScript()));
  });
});
