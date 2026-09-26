import { describe, expect, it } from 'bun:test';
import { DeployProgressMsg, DeployProgressPayload, DeployWatch } from './deploy';
import { DeployServicePayload } from './commands';
import { AgentEnvelope, AgentToControllerMessage, ControllerToAgentMessage, parseAgentEnvelope } from './messages';
import { PROTOCOL_VERSION } from './constants';

const CMD_ID = '00000000-0000-4000-8000-000000000001';
const DIGEST = `sha256:${'4be1'.repeat(16)}`;

const pullProgress = {
  deployId: 'dep_k2x9q7ab',
  stack: 'blog',
  service: 'blog_ghost',
  node: 'london-1',
  stage: 'pull',
  status: 'progress',
  at: 1_758_880_802_000,
  message: 'ghost:5.96-alpine: 3 of 7 layers',
  detail: { layersTotal: 7, layersDone: 3, bytesTotal: 148_000_000, bytesDone: 61_000_000, image: 'ghost:5.96-alpine' },
};

describe('DeployProgressPayload (protocol round-trip gate)', () => {
  it('round-trips a pull progress event unchanged', () => {
    const r = DeployProgressPayload.safeParse(pullProgress);
    expect(r.success).toBe(true);
    if (r.success) expect(JSON.parse(JSON.stringify(r.data))).toEqual(pullProgress);
  });

  it('accepts a minimal controller-stage event (no service, no detail)', () => {
    const r = DeployProgressPayload.safeParse({
      deployId: 'dep_k2x9q7ab',
      stack: 'blog',
      node: 'controller',
      stage: 'health',
      status: 'done',
      at: 1,
      message: 'every part running and the address answering',
    });
    expect(r.success).toBe(true);
  });

  it('carries a verified digest', () => {
    const r = DeployProgressPayload.safeParse({ ...pullProgress, status: 'done', detail: { digest: DIGEST } });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown stage, an unknown status, a bad digest and an empty message', () => {
    expect(DeployProgressPayload.safeParse({ ...pullProgress, stage: 'build' }).success).toBe(false);
    expect(DeployProgressPayload.safeParse({ ...pullProgress, status: 'running' }).success).toBe(false);
    expect(DeployProgressPayload.safeParse({ ...pullProgress, detail: { digest: 'sha256:nope' } }).success).toBe(false);
    expect(DeployProgressPayload.safeParse({ ...pullProgress, message: '' }).success).toBe(false);
  });

  it('rejects a deploy id that is not controller-minted', () => {
    expect(DeployProgressPayload.safeParse({ ...pullProgress, deployId: 'blog' }).success).toBe(false);
  });
});

describe('DeployProgressMsg (discriminated-union gate)', () => {
  it('wraps the payload with the deployProgress discriminant', () => {
    const r = DeployProgressMsg.safeParse({ type: 'deployProgress', payload: pullProgress });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('deployProgress');
  });

  it('is a member of AgentToControllerMessage', () => {
    const r = AgentToControllerMessage.safeParse({ type: 'deployProgress', payload: pullProgress });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('deployProgress');
  });

  it('parses inside a full agent envelope', () => {
    const env = parseAgentEnvelope({
      v: PROTOCOL_VERSION,
      id: CMD_ID,
      ts: 1,
      type: 'deployProgress',
      payload: pullProgress,
    });
    expect(env.type).toBe('deployProgress');
    expect(AgentEnvelope.safeParse({ v: PROTOCOL_VERSION, id: CMD_ID, ts: 1, type: 'deployProgres', payload: pullProgress }).success).toBe(false);
  });

  it('rejects a wrong type literal', () => {
    expect(DeployProgressMsg.safeParse({ type: 'deployEvent', payload: pullProgress }).success).toBe(false);
  });

  it('is NOT something the controller sends', () => {
    expect(ControllerToAgentMessage.safeParse({ type: 'deployProgress', payload: pullProgress }).success).toBe(false);
  });
});

describe('deployService.watch', () => {
  const spec = { name: 'blog_ghost', image: 'ghost:5.96-alpine' };

  it('is optional (older controllers send none)', () => {
    const r = DeployServicePayload.safeParse({ commandId: CMD_ID, spec });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.watch).toBeUndefined();
  });

  it('round-trips a watch through the controller union', () => {
    const watch = { deployId: 'dep_k2x9q7ab', stack: 'blog', role: 'main' };
    const r = ControllerToAgentMessage.safeParse({ type: 'deployService', payload: { commandId: CMD_ID, spec, watch } });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'deployService') expect(r.data.payload.watch).toEqual(watch as DeployWatch);
  });

  it('rejects an unknown role', () => {
    expect(DeployWatch.safeParse({ deployId: 'dep_k2x9q7ab', stack: 'blog', role: 'sidecar' }).success).toBe(false);
  });
});
