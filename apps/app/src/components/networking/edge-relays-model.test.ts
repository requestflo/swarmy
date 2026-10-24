import { describe, expect, test } from 'bun:test';
import { edgeRelaysSentence } from './edge-relays-model';

const edge = (healthy: boolean) => ({ hostname: 'lon-1', address: 'rels://relay.198-51-100-10.sslip.io:443', running: true, healthy });

describe('relays on front doors: the card sentence', () => {
  test('says where relayed traffic goes, in plain words', () => {
    expect(edgeRelaysSentence({ enabled: false, active: false, edges: [] })).toBe(
      "Servers that can't reach each other directly go through this control plane.",
    );
    expect(edgeRelaysSentence({ enabled: true, active: false, edges: [] })).toContain('No front door has a public address yet');
    expect(edgeRelaysSentence({ enabled: true, active: false, edges: [edge(false)] })).toBe('Starting relays on 1 front door…');
    expect(edgeRelaysSentence({ enabled: true, active: true, edges: [edge(true), edge(false)] })).toBe(
      'Relayed traffic goes through 2 front doors (1 answering), so it keeps flowing if this node is gone.',
    );
  });

  test('no glossary words at Summary (relay URLs stay in the Tech line)', () => {
    for (const s of [
      edgeRelaysSentence({ enabled: true, active: true, edges: [edge(true)] }),
      edgeRelaysSentence({ enabled: false, active: false, edges: [] }),
    ]) {
      expect(s).not.toMatch(/mesh|STUN|WireGuard|ingress|node\b(?! is gone)|rels:/i);
    }
  });
});
