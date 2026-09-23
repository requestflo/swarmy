import { describe, expect, it } from 'bun:test';
import { ControllerToAgentMessage } from './protocol/messages';
import { carryNetworkAliases, toServiceCreateOptions } from './docker';

const CMD_ID = '00000000-0000-4000-8000-000000000001';

type Opts = { TaskTemplate: { Networks?: Array<{ Target: string; Aliases?: string[] }> } };

/**
 * Network aliases survive the wire and land on TaskTemplate.Networks[].Aliases
 * — the mechanism that makes `db:5432` resolve inside a compose stack (the
 * `<stack>_default` overlay aliased with the short compose service name).
 */
describe('ServiceSpec.networkAliases round-trip', () => {
  const spec = {
    name: 'shop_web',
    image: 'nginx:1.27-alpine',
    networks: ['shop_default', 'swarmy'],
    networkAliases: { shop_default: ['web'] },
  };

  it('parses through ControllerToAgentMessage unchanged', () => {
    const wire = JSON.parse(
      JSON.stringify({ type: 'deployService', payload: { commandId: CMD_ID, spec } }),
    );
    const parsed = ControllerToAgentMessage.parse(wire);
    if (parsed.type !== 'deployService') throw new Error('wrong type');
    expect(parsed.payload.spec.networkAliases).toEqual({ shop_default: ['web'] });
    expect(parsed.payload.spec.networks).toEqual(['shop_default', 'swarmy']);
  });

  it('rejects a non-array alias value', () => {
    const wire = {
      type: 'deployService',
      payload: { commandId: CMD_ID, spec: { ...spec, networkAliases: { shop_default: 'web' } } },
    };
    expect(ControllerToAgentMessage.safeParse(wire).success).toBe(false);
  });

  it('maps aliases onto the matching TaskTemplate network only', () => {
    const opts = toServiceCreateOptions(spec) as unknown as Opts;
    expect(opts.TaskTemplate.Networks).toEqual([
      { Target: 'shop_default', Aliases: ['web'] },
      { Target: 'swarmy' },
    ]);
  });

  it('no aliases → plain targets (unchanged legacy shape)', () => {
    const opts = toServiceCreateOptions({
      name: 'x',
      image: 'x',
      networks: ['n'],
    }) as unknown as Opts;
    expect(opts.TaskTemplate.Networks).toEqual([{ Target: 'n' }]);
  });
});

describe('carryNetworkAliases (update keeps live aliases)', () => {
  const live = [
    { Target: 'id-default', Aliases: ['web'] },
    { Target: 'id-swarmy', Aliases: [] },
  ];

  it('a lossy rebuild (no networkAliases) keeps the live alias per network id', () => {
    const opts = {
      TaskTemplate: { Networks: [{ Target: 'id-default' }, { Target: 'id-swarmy' }] },
    } as Opts;
    carryNetworkAliases(opts, {}, live);
    expect(opts.TaskTemplate.Networks).toEqual([
      { Target: 'id-default', Aliases: ['web'] },
      { Target: 'id-swarmy' },
    ]);
  });

  it('an explicit networkAliases is authoritative (nothing carried)', () => {
    const opts = { TaskTemplate: { Networks: [{ Target: 'id-default' }] } } as Opts;
    carryNetworkAliases(opts, { networkAliases: {} }, live);
    expect(opts.TaskTemplate.Networks).toEqual([{ Target: 'id-default' }]);
  });

  it('a network the new spec leaves is not re-added', () => {
    const opts = { TaskTemplate: { Networks: [{ Target: 'id-swarmy' }] } } as Opts;
    carryNetworkAliases(opts, {}, live);
    expect(opts.TaskTemplate.Networks).toEqual([{ Target: 'id-swarmy' }]);
  });
});
