import { describe, expect, it } from 'bun:test';
import { RUM_SETTINGS_LABEL, readRumSettings } from '@swarmy/rum';
import { setRumSettings } from './rum-settings.service';

/** QA-031: rum.setSettings answers with what it saved, not the lagging inventory. */
describe('setRumSettings', () => {
  it('returns the saved settings even though the live labels have not caught up', async () => {
    const svc = {
      id: 's1',
      name: 'shop_web',
      image: 'x',
      mode: 'replicated',
      desiredReplicas: 1,
      runningReplicas: 1,
      labels: { 'com.docker.stack.namespace': 'shop' },
      networks: [],
      env: [],
      ports: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const writes: unknown[] = [];
    const ctx = {
      activeOrgId: 'org1',
      user: { id: 'u1' },
      db: { auditLog: { create: async ({ data }: { data: unknown }) => data } },
      hub: {
        // The inventory never reflects the write within this request.
        liveInventory: () => ({ services: [svc], containers: [] }),
        managerNode: () => 'n1',
        isOnline: () => true,
        dispatch: async (_n: string, _c: string, p: unknown) => {
          writes.push(p);
          return {};
        },
      },
    } as never;
    const before = readRumSettings(undefined);
    const wanted = { ...before, enabled: !before.enabled, replaySampleRate: 0.25 };
    const view = await setRumSettings(ctx, { stack: 'shop', settings: wanted }, async () => undefined);
    expect(writes).toHaveLength(1);
    expect(view.settings.enabled).toBe(wanted.enabled);
    expect(view.settings.replaySampleRate).toBe(0.25);
    expect(RUM_SETTINGS_LABEL.length).toBeGreaterThan(0);
  });
});
