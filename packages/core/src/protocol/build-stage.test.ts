import { describe, expect, it } from 'bun:test';
import { BUILD_STAGE_ORDER, BuildStageKey, BuildStageMsg, BuildStagePayload } from './build-stage';
import { BuildImagePayload } from './build';
import { AgentEnvelope, AgentToControllerMessage, ControllerToAgentMessage, parseAgentEnvelope } from './messages';
import { PROTOCOL_VERSION } from './constants';

const CMD_ID = '00000000-0000-4000-8000-000000000001';
const entered = { commandId: CMD_ID, stage: 'push' };

describe('BuildStagePayload (protocol round-trip gate)', () => {
  it('round-trips a stage entry unchanged', () => {
    const r = BuildStagePayload.safeParse(entered);
    expect(r.success).toBe(true);
    if (r.success) expect(JSON.parse(JSON.stringify(r.data))).toEqual(entered);
  });

  it('accepts only the stages the builder runs', () => {
    for (const stage of ['clone', 'build', 'push']) expect(BuildStagePayload.safeParse({ ...entered, stage }).success).toBe(true);
    // scan / sign / rollout are the controller's own — an agent never reports them.
    for (const stage of ['scan', 'sign', 'rollout', 'deploy']) expect(BuildStagePayload.safeParse({ ...entered, stage }).success).toBe(false);
  });

  it('rejects a missing or malformed commandId', () => {
    expect(BuildStagePayload.safeParse({ stage: 'clone' }).success).toBe(false);
    expect(BuildStagePayload.safeParse({ ...entered, commandId: '' }).success).toBe(false);
  });

  it('orders the six stages the build page shows', () => {
    expect([...BUILD_STAGE_ORDER]).toEqual(['clone', 'build', 'push', 'scan', 'sign', 'rollout']);
    expect(BuildStageKey.safeParse('rollout').success).toBe(true);
  });
});

describe('BuildStageMsg (discriminated-union gate)', () => {
  it('is a member of AgentToControllerMessage with the buildStage discriminant', () => {
    const r = AgentToControllerMessage.safeParse({ type: 'buildStage', payload: entered });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('buildStage');
    expect(BuildStageMsg.safeParse({ type: 'buildStage', payload: entered }).success).toBe(true);
  });

  it('parses inside a full agent envelope and rejects a wrong type literal', () => {
    const env = parseAgentEnvelope({ v: PROTOCOL_VERSION, id: CMD_ID, ts: 1, type: 'buildStage', payload: entered });
    expect(env.type).toBe('buildStage');
    expect(AgentEnvelope.safeParse({ v: PROTOCOL_VERSION, id: CMD_ID, ts: 1, type: 'buildStages', payload: entered }).success).toBe(false);
    expect(BuildStageMsg.safeParse({ type: 'buildProgress', payload: entered }).success).toBe(false);
  });

  it('is NOT something the controller sends', () => {
    expect(ControllerToAgentMessage.safeParse({ type: 'buildStage', payload: entered }).success).toBe(false);
  });
});

describe('buildImage.reportStages', () => {
  const base = { commandId: CMD_ID, source: { url: 'https://github.com/o/r' }, imageRefs: ['localhost:5000/o-r:main'] };

  it('is optional (older controllers send none)', () => {
    const r = BuildImagePayload.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reportStages).toBeUndefined();
  });

  it('round-trips through the controller union', () => {
    const r = ControllerToAgentMessage.safeParse({ type: 'buildImage', payload: { ...base, reportStages: true } });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'buildImage') expect(r.data.payload.reportStages).toBe(true);
    expect(BuildImagePayload.safeParse({ ...base, reportStages: 'yes' }).success).toBe(false);
  });
});
