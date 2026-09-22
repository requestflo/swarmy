import { describe, expect, it } from 'bun:test';
import { ControllerToAgentMessage } from './messages';
import { ApplyStorageNodeMsg, RenderedStoreDeployment } from './storage';

const CMD_ID = '00000000-0000-4000-8000-000000000002';

const rendered = {
  driver: 'garage' as const,
  files: [],
  serviceName: 'swarmy-garage',
  image: 'dxflrs/garage:v1.0.1',
  s3Port: 3900,
  adminPort: 3903,
  configs: [{ source: 'swarmy-garage-config-abcd1234', target: '/etc/garage.toml', mode: 0o400 }],
  placement: { constraints: ['node.labels.swarmy.garage.member==true'] },
  serviceMode: 'global' as const,
  networks: ['swarmy'],
  summary: 'Garage',
};

describe('RenderedStoreDeployment.networks', () => {
  it('is optional — legacy renders without it still validate', () => {
    const { networks: _n, ...legacy } = rendered;
    const r = RenderedStoreDeployment.safeParse(legacy);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.networks).toBeUndefined();
  });

  it('rejects an empty network name', () => {
    expect(RenderedStoreDeployment.safeParse({ ...rendered, networks: [''] }).success).toBe(false);
  });
});

describe('ApplyStorageNodeMsg round-trip through ControllerToAgentMessage', () => {
  it('carries networks across JSON serialise → discriminated-union parse', () => {
    const msg = { type: 'applyStorageNode' as const, payload: { commandId: CMD_ID, rendered } };
    const wire = JSON.parse(JSON.stringify(ApplyStorageNodeMsg.parse(msg)));
    const parsed = ControllerToAgentMessage.parse(wire);
    expect(parsed.type).toBe('applyStorageNode');
    if (parsed.type === 'applyStorageNode') {
      expect(parsed.payload.rendered.networks).toEqual(['swarmy']);
      expect(parsed.payload.rendered).toEqual(rendered);
    }
  });
});
