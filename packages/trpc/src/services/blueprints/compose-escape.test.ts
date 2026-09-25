import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { findAppTemplate } from '@swarmy/templates';
import { escapeInterpolation, interpolateCompose } from '@swarmy/core/compose';
import { compileTemplate } from './from-app-config';

/** QA-047: generated compose keeps `$VAR` and `%s` exactly through the stack deploy. */
describe('generated compose survives interpolation', () => {
  it('escapeInterpolation doubles every $ and interpolation undoes it exactly', () => {
    const doc = { services: { w: { command: ['sh', '-c', `printf '%s' "$X" && echo \${Y:-z} $$`] } } };
    const escaped = escapeInterpolation(doc);
    expect(escaped.services.w.command[2]).toBe(`printf '%s' "$$X" && echo $\${Y:-z} $$$$`);
    expect(interpolateCompose(escaped, {}).doc).toEqual(doc);
    expect(interpolateCompose(escaped, {}).warnings).toEqual([]);
  });

  it('golden: the bullmq-worker template reaches the container with its printf commands intact', () => {
    const t = findAppTemplate('bullmq-worker')!;
    const { steps } = compileTemplate(t, { name: 'jobs', size: 'm', options: {} } as never);
    const deploy = (steps as Array<{ kind: string; payload: { composeSource?: string } }>).find((s) => s.kind === 'stack.deploy')!;
    const { doc, warnings } = interpolateCompose(parseYaml(deploy.payload.composeSource!), {});
    expect(warnings).toEqual([]);
    const commands = Object.values((doc as { services: Record<string, { command?: string[] }> }).services)
      .map((s) => (s.command ?? []).join(' '))
      .filter((c) => c.includes('printf'));
    expect(commands.length).toBe(2);
    for (const c of commands) {
      expect(c).toContain(`printf '%s' "$BULLMQ_CONNECT" > connect.js`);
      expect(c).not.toContain('undefined');
      expect(c).not.toContain(`printf '%s' "" >`);
    }
  });
});

describe('git apps (swarmy.yaml → compose)', () => {
  it('a $VAR in a swarmy.yaml command reaches the container literally', async () => {
    const { parseAppConfig, toDesired } = await import('@swarmy/app-config');
    const { compileServices } = await import('../apps/compile');
    const res = parseAppConfig(
      'version: 1\napp: shop\nservices:\n  worker:\n    image: busybox:1.36\n    command: ["sh", "-c", "echo $HOSTNAME $(date +%s)"]\n',
    );
    const out = compileServices(toDesired(res.config!), { worker: 'busybox:1.36' });
    const { doc } = interpolateCompose(parseYaml(out.composeSource), {});
    const cmd = (doc as { services: Record<string, { command?: string[] }> }).services.worker!.command!;
    expect(cmd.join(' ')).toContain('echo $HOSTNAME $(date +%s)');
  });
});
