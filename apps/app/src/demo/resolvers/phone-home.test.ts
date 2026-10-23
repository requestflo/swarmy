import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { HANDLERS } from '../registry';
import { getStore } from '../store';

const g = globalThis as { window?: unknown };
const hadWindow = 'window' in g;

describe('phone-home demo', () => {
  // The demo seeds build a few links from the page's origin.
  beforeAll(() => {
    if (!hadWindow) g.window = { location: { origin: 'https://demo.test' } };
  });
  afterAll(() => {
    if (!hadWindow) delete g.window;
  });
  afterEach(() => setSystemTime());

  test('a minted link brings a new server into nodes.list ~25 s later, on the private network', () => {
    const store = getStore();
    const before = (HANDLERS['nodes.list']!(undefined, store) as unknown[]).length;
    const issued = HANDLERS['nodes.generateJoinToken']!({}, store) as { id: string; meshSetupKey?: string };
    expect(issued.meshSetupKey).toStartWith('NB-DEMO-');
    expect((HANDLERS['nodes.list']!(undefined, store) as unknown[]).length).toBe(before);

    setSystemTime(new Date(Date.now() + 26_000));
    const after = HANDLERS['nodes.list']!(undefined, store) as { id: string; name: string; status: string }[];
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ name: 'pi-garage', status: 'online' });
    const peers = HANDLERS['mesh.listPeers']!(undefined, store) as { nodeId: string; status: string }[];
    expect(peers.find((p) => p.nodeId === after.at(-1)!.id)?.status).toBe('CONNECTED');
    const tokens = HANDLERS['nodes.listJoinTokens']!(undefined, store) as { id: string; status: string }[];
    expect(tokens.find((t) => t.id === issued.id)?.status).toBe('exhausted');
  });
});
