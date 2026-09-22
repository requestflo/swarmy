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

/**
 * Docker SECRETS on a ServiceSpec survive the wire and map onto
 * ContainerSpec.Secrets with the `/run/secrets/<target>` file name — how
 * managed-service credentials (ClickHouse password, Garage rpc secret / admin
 * token) reach a task without ever riding in a (world-inspectable) config.
 */
describe('ServiceSpec.secrets round-trip', () => {
  const spec = {
    name: 'swarmy-clickhouse',
    image: 'clickhouse/clickhouse-server:24.8-alpine',
    env: { CLICKHOUSE_PASSWORD_FILE: '/run/secrets/clickhouse-password' },
    secrets: [{ source: 'swarmy-clickhouse-password-abcd1234', target: 'clickhouse-password', mode: 0o444 }],
  };

  it('parses through ControllerToAgentMessage unchanged', () => {
    const wire = JSON.parse(
      JSON.stringify({ type: 'deployService', payload: { commandId: CMD_ID, spec } }),
    );
    const parsed = ControllerToAgentMessage.parse(wire);
    if (parsed.type !== 'deployService') throw new Error('wrong type');
    expect(parsed.payload.spec.secrets).toEqual(spec.secrets);
  });

  it('maps to ContainerSpec.Secrets with File.Name = target', () => {
    const opts = toServiceCreateOptions(spec) as {
      TaskTemplate: { ContainerSpec: { Secrets?: unknown[] } };
    };
    expect(opts.TaskTemplate.ContainerSpec.Secrets).toEqual([
      {
        SecretName: 'swarmy-clickhouse-password-abcd1234',
        File: { Name: 'clickhouse-password', UID: '0', GID: '0', Mode: 0o444 },
      },
    ]);
  });

  it('applyStorageNode carries rendered.secrets over the wire (Garage *_file secrets)', () => {
    const rendered = {
      driver: 'garage',
      serviceName: 'swarmy-garage',
      image: 'dxflrs/garage:v1.0.1',
      s3Port: 3900,
      secrets: [{ source: 'swarmy-garage-rpc-secret-11111111', target: 'garage-rpc-secret', mode: 0o400 }],
    };
    const parsed = ControllerToAgentMessage.parse(
      JSON.parse(JSON.stringify({ type: 'applyStorageNode', payload: { commandId: CMD_ID, rendered } })),
    );
    if (parsed.type !== 'applyStorageNode') throw new Error('wrong type');
    expect(parsed.payload.rendered.secrets).toEqual(rendered.secrets);
  });
});
