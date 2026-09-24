import { describe, expect, it } from 'bun:test';
import { SwarmyEmail, SwarmyEmailError } from '../src/email';

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }>) {
  return async (url: string, init?: RequestInit) => {
    seen.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

describe('SwarmyEmail', () => {
  it('POSTs to <EMAIL_API_URL>/send with the app key', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const email = new SwarmyEmail({ apiUrl: 'https://swarm.test/email/v1/', apiKey: 'sem_x', fetch: fakeFetch(202, { id: '<1@a.co>', accepted: ['b@c.co'], suppressed: [], rejected: [] }, seen) });
    const r = await email.send({ from: 'a@a.co', to: 'b@c.co', template: 'welcome', variables: { name: 'Ada' } });
    expect(r.id).toBe('<1@a.co>');
    expect(seen[0]!.url).toBe('https://swarm.test/email/v1/send');
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Bearer sem_x');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ from: 'a@a.co', to: 'b@c.co', template: 'welcome', variables: { name: 'Ada' } });
  });

  it('maps API errors', async () => {
    const email = new SwarmyEmail({ apiUrl: 'https://swarm.test/email/v1', apiKey: 'sem_x', fetch: fakeFetch(422, { error: { code: 'all_suppressed', message: 'nope', suppressed: ['b@c.co'] } }, []) });
    const e = await email.send({ from: 'a@a.co', to: 'b@c.co', text: 'x', subject: 's' }).catch((x) => x);
    expect(e).toBeInstanceOf(SwarmyEmailError);
    expect(e).toMatchObject({ status: 422, code: 'all_suppressed', details: { suppressed: ['b@c.co'] } });
  });

  it('fromEnv reads the swarmy.yaml bindings', () => {
    expect(() => SwarmyEmail.fromEnv({})).toThrow('EMAIL_API_URL');
    expect(SwarmyEmail.fromEnv({ EMAIL_API_URL: 'https://x/email/v1', EMAIL_API_KEY: 'sem_1' })).toBeInstanceOf(SwarmyEmail);
  });
});
