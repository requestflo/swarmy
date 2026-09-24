import { describe, expect, test } from 'bun:test';
import { createApiTokenVerifier, MCP_OIDC_CLIENT, swarmyApiAudiences } from './api-tokens';
import { oidcClientRow } from './oidc-clients';

const env = { BETTER_AUTH_URL: 'https://ctl.example', CONTROLLER_PUBLIC_URL: 'https://ctl.example' };
const b64u = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? b : b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');

async function keyPair() {
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const sign = async (payload: Record<string, unknown>) => {
    const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const body = b64u(JSON.stringify(payload));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64u(sig)}`;
  };
  return { jwk, sign };
}

describe('swarmy API access tokens', () => {
  test('audiences are the MCP and REST URLs', () => {
    expect(swarmyApiAudiences(env)).toEqual(['https://ctl.example/mcp', 'https://ctl.example/api/v1']);
  });

  test('verifies issuer, audience and signature; reads sub/scope/org', async () => {
    const { jwk, sign } = await keyPair();
    let jwksCalls = 0;
    const auth = {
      handler: async (req: Request) => {
        expect(new URL(req.url).pathname).toBe('/api/auth/jwks');
        jwksCalls++;
        return Response.json({ keys: [jwk] });
      },
    };
    const verify = createApiTokenVerifier(() => auth, env);
    const now = Math.floor(Date.now() / 1000);
    const base = { iss: 'https://ctl.example/api/auth', sub: 'u1', iat: now, exp: now + 600, scope: 'openid swarmy:write', org: 'org_1', azp: 'swarmy-mcp' };

    expect(await verify(await sign({ ...base, aud: 'https://ctl.example/mcp' }))).toEqual({
      userId: 'u1',
      scopes: ['openid', 'swarmy:write'],
      orgId: 'org_1',
      clientId: 'swarmy-mcp',
    });
    // Another relying party's token (NetBird's audience) is refused.
    expect(await verify(await sign({ ...base, aud: 'swarmy-netbird' }))).toBeNull();
    expect(await verify(await sign({ ...base, aud: 'https://ctl.example/mcp', iss: 'https://evil.example' }))).toBeNull();
    expect(await verify(await sign({ ...base, aud: 'https://ctl.example/mcp', exp: now - 10 }))).toBeNull();
    expect(await verify('swk_notajwt')).toBeNull();
    const forged = (await sign({ ...base, aud: 'https://ctl.example/mcp' })).replace(/\.[^.]+$/, '.AAAA');
    expect(await verify(forged)).toBeNull();
    expect(jwksCalls).toBeGreaterThanOrEqual(1);
  });

  test('the MCP client may request the API scopes; other clients keep identity scopes', () => {
    const row = oidcClientRow(MCP_OIDC_CLIENT());
    expect(row.public).toBe(true);
    expect(row.requirePKCE).toBe(true);
    expect(row.scopes).toEqual(expect.arrayContaining(['swarmy:read', 'swarmy:write']));
    const other = oidcClientRow({ clientId: 'x', name: 'x', type: 'public', redirectUris: ['http://localhost:1'] });
    expect(other.scopes).not.toContain('swarmy:write');
  });
});
