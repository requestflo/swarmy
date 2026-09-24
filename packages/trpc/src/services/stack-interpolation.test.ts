import { describe, expect, test } from 'bun:test';
import { composeShortSpecs, planComposeStack, stackVariables } from './stack.service';

const COMPOSE = `
services:
  web:
    image: ghcr.io/acme/web:\${TAG:-latest}
    environment:
      API_URL: \${API_URL:?set API_URL in the stack variables}
      PRICE: "$$5"
    command: ["sh", "-c", "echo $$HOSTNAME"]
`;

describe('stack deploy interpolation', () => {
  test('the stack .env feeds ${VAR}; $$ stays a literal $', () => {
    const { vars } = stackVariables('TAG=2.0\nAPI_URL=https://api.example.com\n');
    const plan = planComposeStack(COMPOSE, 'shop', undefined, vars);
    const web = plan.specs.find((s) => s.name === 'shop_web')!;
    expect(web.image).toBe('ghcr.io/acme/web:2.0');
    expect(web.env).toMatchObject({ API_URL: 'https://api.example.com', PRICE: '$5' });
    expect(web.args).toEqual(['sh', '-c', 'echo $HOSTNAME']);
  });

  test('a missing required variable is a 400 naming the path and the hint', () => {
    expect(() => planComposeStack(COMPOSE, 'shop', undefined, {})).toThrow(
      /services\.web\.environment\.API_URL: required variable API_URL is missing a value: set API_URL in the stack variables/,
    );
  });

  test('unset optional variables warn; defaults apply (previews path too)', () => {
    const { specs, warnings } = composeShortSpecs('services:\n  a:\n    image: nginx:${TAG:-1}\n    environment: { X: $UNSET }\n');
    expect(specs[0]!.image).toBe('nginx:1');
    expect(warnings.some((w) => w.code === 'unset-variable' && w.message.includes('"UNSET"'))).toBe(true);
  });

  test('.env parse problems surface as warnings, never a throw', () => {
    const r = stackVariables('GOOD=1\nnot a line\n');
    expect(r.vars).toEqual({ GOOD: '1' });
    expect(r.warnings[0]).toMatchObject({ code: 'dotenv', path: '.env:2' });
  });
});
