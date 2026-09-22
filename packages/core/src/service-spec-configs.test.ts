import { describe, expect, it } from 'bun:test';
import { ControllerToAgentMessage } from './protocol/messages';
import { toServiceCreateOptions } from './docker';

const CMD_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Docker configs on a ServiceSpec survive the wire (JSON → discriminated-union
 * parse) and map onto the swarm API's ContainerSpec.Configs with the in-
 * container target path — the zero-host-files path for rendered configs.
 */
describe('ServiceSpec.configs round-trip', () => {
  const spec = {
    name: 'swarmy-otel-collector',
    image: 'otel/opentelemetry-collector-contrib:0.111.0',
    configs: [{ source: 'swarmy-otel-collector-config-abcd1234', target: '/etc/otelcol-contrib/config.yaml', mode: 0o444 }],
    placement: { constraints: ['node.id==swarmnode1'] },
  };

  it('parses through ControllerToAgentMessage unchanged', () => {
    const wire = JSON.parse(
      JSON.stringify({ type: 'deployService', payload: { commandId: CMD_ID, spec } }),
    );
    const parsed = ControllerToAgentMessage.parse(wire);
    expect(parsed.type).toBe('deployService');
    if (parsed.type !== 'deployService') throw new Error('wrong type');
    expect(parsed.payload.spec.configs).toEqual(spec.configs);
    expect(parsed.payload.spec.placement).toEqual(spec.placement);
  });

  it('maps to ContainerSpec.Configs with File.Name = target and no bind mounts', () => {
    const opts = toServiceCreateOptions(spec) as {
      TaskTemplate: {
        ContainerSpec: { Configs?: unknown[]; Mounts?: unknown[] };
        Placement?: { Constraints?: string[] };
      };
    };
    expect(opts.TaskTemplate.ContainerSpec.Configs).toEqual([
      {
        ConfigName: 'swarmy-otel-collector-config-abcd1234',
        File: { Name: '/etc/otelcol-contrib/config.yaml', UID: '0', GID: '0', Mode: 0o444 },
      },
    ]);
    expect(opts.TaskTemplate.ContainerSpec.Mounts).toBeUndefined();
    expect(opts.TaskTemplate.Placement?.Constraints).toEqual(['node.id==swarmnode1']);
  });
});
