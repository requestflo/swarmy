import { describe, expect, it } from 'bun:test';
import { HYGIENE_DEFAULTS, NodeHygieneMsg, NodeHygienePayload } from './hygiene';
import { ControllerToAgentMessage } from './messages';

const commandId = '00000000-0000-4000-8000-000000000001';

describe('nodeHygiene protocol', () => {
  it('parses a minimal payload with safe defaults', () => {
    const p = NodeHygienePayload.parse({ commandId });
    expect(p).toMatchObject({
      keepDigests: [],
      keepRefs: [],
      imageMinAgeDays: HYGIENE_DEFAULTS.imageMinAgeDays,
      containerMinAgeHours: 1,
      buildCacheKeepBytes: 5 * 1024 ** 3,
      images: true,
      containers: true,
      buildCache: true,
      dryRun: false,
    });
  });

  it('rejects bad payloads', () => {
    expect(NodeHygienePayload.safeParse({}).success).toBe(false);
    expect(NodeHygienePayload.safeParse({ commandId, imageMinAgeDays: 0 }).success).toBe(false);
    expect(NodeHygienePayload.safeParse({ commandId, buildCacheKeepBytes: -1 }).success).toBe(false);
  });

  it('is a ControllerToAgentMessage variant with the nodeHygiene discriminant', () => {
    const msg = NodeHygieneMsg.parse({ type: 'nodeHygiene', payload: { commandId } });
    expect(msg.type).toBe('nodeHygiene');
    expect(NodeHygieneMsg.safeParse({ type: 'pruneImages', payload: { commandId } }).success).toBe(false);
    const union = ControllerToAgentMessage.safeParse({ type: 'nodeHygiene', payload: { commandId } });
    expect(union.success).toBe(true);
  });
});
