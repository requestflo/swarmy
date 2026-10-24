import { describe, expect, it } from 'bun:test';
import { SWARMY_INTEGRATIONS_NETWORK as NET } from '@swarmy/core';
import { carryIntegrationsNetwork, enginesAfterDeploy } from './integrations-carry';

const live = (name: string, image: string, nets: string[] = [], labels: Record<string, string> = {}) => ({
  name,
  image,
  labels,
  networks: nets.map((n) => ({ name: n })),
});
const spec = (name: string, image: string, networks: string[] = ['llm_default'], labels?: Record<string, string>) => ({
  name,
  image,
  networks,
  ...(labels ? { labels } : {}),
});

describe('swarmy-integrations at deploy time (AI engines stay reachable by service name)', () => {
  it('a redeployed engine keeps the overlay in the same update', () => {
    const before = [live('llm_ollama', 'ollama/ollama:0.34.4', ['llm_default', NET])];
    const [out] = carryIntegrationsNetwork([spec('llm_ollama', 'ollama/ollama:0.35.0')], before);
    expect(out!.networks).toEqual(['llm_default', NET]);
  });

  it('a first-deploy engine joins at once; the app beside it does not', () => {
    const out = carryIntegrationsNetwork([spec('llm_vllm', 'vllm/vllm-openai:v0.9.1'), spec('llm_web', 'nginx:1.27')], []);
    expect(out.map((s) => s.networks)).toEqual([['llm_default', NET], ['llm_default']]);
  });

  it('an engine registered by label (`swarmy.ai.provider`) counts too', () => {
    const [out] = carryIntegrationsNetwork([spec('llm_tgi', 'ghcr.io/x/tgi:2', ['llm_default'], { 'swarmy.ai.provider': 'vllm' })], []);
    expect(out!.networks).toContain(NET);
  });

  it('only the engine discovery picks: a second Ollama is not attached', () => {
    const before = [live('a_ollama', 'ollama/ollama:0.34.4', [NET])];
    expect([...enginesAfterDeploy([spec('b_ollama', 'ollama/ollama:0.34.4')], before)]).toEqual(['a_ollama']);
    const [out] = carryIntegrationsNetwork([spec('b_ollama', 'ollama/ollama:0.34.4')], before);
    expect(out!.networks).toEqual(['llm_default']);
  });

  it('a service swarmy attached (an alert target) keeps it; untouched specs are the same object', () => {
    const ntfy = spec('ops_ntfy', 'binwiederhier/ntfy:v2.11');
    const web = spec('ops_web', 'nginx:1.27');
    const out = carryIntegrationsNetwork([ntfy, web], [live('ops_ntfy', 'binwiederhier/ntfy:v2.11', [NET])]);
    expect(out[0]!.networks).toEqual(['llm_default', NET]);
    expect(out[1]).toBe(web);
  });

  it('never adds the overlay twice', () => {
    const s = spec('llm_ollama', 'ollama/ollama:0.34.4', ['llm_default', NET]);
    expect(carryIntegrationsNetwork([s], [])[0]).toBe(s);
  });
});
