import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SWARMY_INTEGRATIONS_NETWORK, networkIsolationViolations } from '@swarmy/core';
import { composeToStack } from '@swarmy/core/compose';
import { integrationTargets, planIntegrations } from './integrations-network';

const net = (...names: string[]) => names.map((name) => ({ name, aliases: [] }));
const svc = (name: string, ...nets: string[]) => ({ name, networks: net(...nets) });

describe('swarmy-integrations (QA-042)', () => {
  it('targets are the in-swarm services the URLs name; public hosts and swarmy services are not', () => {
    const live = [svc('qa6-ollama_ollama', 'qa6-ollama_default'), svc('qa6-alert_ntfy'), svc('shop_web'), svc('swarmy-garage')];
    expect(
      integrationTargets(
        [
          'http://qa6-ollama_ollama:11434',
          'http://qa6-alert_ntfy',
          'https://hooks.slack.com/services/x',
          'http://tasks.shop_web:8080/hook',
          'http://swarmy-garage:3900',
          'not a url',
        ],
        live,
      ),
    ).toEqual(['qa6-alert_ntfy', 'qa6-ollama_ollama', 'shop_web']);
  });

  it('attaches targets, detaches strays, and puts the controller on it once a target exists', () => {
    const live = [
      svc('swarmy_controller', 'swarmy-control'),
      svc('qa6-ollama_ollama', 'qa6-ollama_default'),
      svc('old_target', SWARMY_INTEGRATIONS_NETWORK),
      svc('swarmy-dns', SWARMY_INTEGRATIONS_NETWORK),
    ];
    expect(planIntegrations(live, ['qa6-ollama_ollama'])).toEqual({
      attach: ['qa6-ollama_ollama'],
      detach: ['old_target'],
      controller: true,
    });
  });

  it('apps are never attached by default: no targets → no controller change, strays still detached', () => {
    const live = [svc('swarmy_controller', 'swarmy-control'), svc('shop_web', 'shop_default')];
    expect(planIntegrations(live, [])).toEqual({ attach: [], detach: [], controller: false });
    const onAlready = [svc('swarmy_controller', 'swarmy-control', SWARMY_INTEGRATIONS_NETWORK), svc('t', SWARMY_INTEGRATIONS_NETWORK)];
    expect(planIntegrations(onAlready, ['t'])).toEqual({ attach: [], detach: [], controller: false });
  });

  it('compose may not declare it; aliases on it are refused; the control plane stays private', () => {
    expect(() =>
      composeToStack(
        { services: { web: { image: 'nginx', networks: ['x'] } }, networks: { x: { external: true, name: SWARMY_INTEGRATIONS_NETWORK } } },
        'shop',
      ),
    ).toThrow(/can't declare it/);
    expect(
      networkIsolationViolations([{ name: 'web', networks: [SWARMY_INTEGRATIONS_NETWORK], networkAliases: { [SWARMY_INTEGRATIONS_NETWORK]: ['ollama'] } }]).map((v) => v.rule),
    ).toEqual(['network.platform-alias']);
  });

  it('the controller joins it in the stack file, and the installer creates it', () => {
    const root = path.resolve(import.meta.dir, '../../../..');
    const stack = readFileSync(path.join(root, 'deploy/swarmy.lite.stack.yml'), 'utf8');
    expect(stack).toContain('      - swarmy-integrations\n');
    expect(stack).toContain('  swarmy-integrations:\n    external: true\n    name: swarmy-integrations\n');
    const inst = readFileSync(path.join(root, 'scripts/install-swarmy.sh'), 'utf8');
    expect(inst).toContain('create_overlay "$INTEGRATIONS_NET" integrations');
  });
});
