import { describe, expect, it } from 'bun:test';
import { composeToAppConfig } from './from-compose';
import { looksLikeCredential, secretNameFor } from './from-compose-env';
import { portsOf, volumesOf } from './from-compose-read';
import { parseAppConfig } from './parse';

/** A compose file full of things swarmy.yaml can't say. */
const GNARLY = `
services:
  agent:
    image: ghcr.io/acme/agent:3
    privileged: true
    cap_add: [NET_ADMIN]
    network_mode: host
    restart: unless-stopped
    deploy: { mode: global, update_config: { parallelism: 1 } }
    healthcheck: { test: ["CMD", "true"] }
    ports: ["9100:9100", "9200"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./conf:/etc/agent
      - /scratch
      - cache:/var/cache/agent
    environment:
      API_TOKEN: tok_8f2c41d9a7e3
      UPSTREAM_URL: https://ops:hunter22@upstream.example.com
      REGION: \${REGION}
      MAX_PASSWORD_TRIES: "5"
      LOG_LEVEL: info
  db:
    image: postgres:13
    environment: { POSTGRES_PASSWORD: example }
    volumes: [pgdata:/var/lib/postgresql/data]
    ports: ["5432:5432"]
  reports:
    image: postgres:15-alpine
`;

describe('composeToAppConfig: what didn’t translate', () => {
  const r = composeToAppConfig(GNARLY, { app: 'ops' });
  const why = (service: string, key: string) => r.untranslated.find((g) => g.service === service && g.key === key);

  it('still writes a file the controller’s parser accepts', () => {
    expect(r.yaml).not.toBeNull();
    const parsed = parseAppConfig(r.yaml!);
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(parsed.config?.services.agent?.volumes).toEqual({ cache: '/var/cache/agent' });
    expect(parsed.config?.services.agent?.port).toBe(9100);
  });

  it('names each key swarmy.yaml has no home for, with why', () => {
    expect(why('agent', 'privileged')?.reason).toContain("can't run privileged");
    expect(why('agent', 'cap_add')).toBeDefined();
    expect(why('agent', 'network_mode')).toBeDefined();
    expect(why('agent', 'healthcheck')?.reason).toContain('healthcheck:');
    expect(why('agent', 'deploy.mode')?.reason).toContain('replicas:');
    expect(why('agent', 'restart')).toMatchObject({ handled: true });
    expect(why('agent', 'deploy.update_config')).toMatchObject({ handled: true });
    expect(why('agent', 'privileged')?.handled).toBeUndefined();
  });

  it('drops host folders, the Docker socket and unnamed volumes; keeps named ones', () => {
    expect(why('agent', 'volumes: /var/run/docker.sock:/var/run/docker.sock')?.reason).toContain('Docker socket');
    expect(why('agent', 'volumes: ./conf:/etc/agent')?.reason).toContain('a folder on one server');
    expect(why('agent', 'volumes: /scratch')?.reason).toContain('unnamed volume');
    expect(why('agent', 'volumes: cache:/var/cache/agent')).toBeUndefined();
  });

  it('keeps one port and says what happened to the rest', () => {
    expect(why('agent', 'ports: 9100:9100')?.reason).toContain("port 9100 isn't opened on every server");
    expect(why('agent', 'ports: 9200')?.reason).toContain('one port:');
  });

  it('keeps credentials out of the file and flags compose variables', () => {
    const env = parseAppConfig(r.yaml!).config?.services.agent?.env;
    expect(env?.API_TOKEN).toBe('${{ secrets.api-token }}');
    expect(env?.UPSTREAM_URL).toBe('${{ secrets.upstream-url }}');
    expect(env?.MAX_PASSWORD_TRIES).toBe('5');
    expect(env?.LOG_LEVEL).toBe('info');
    expect(r.yaml).not.toContain('tok_8f2c41d9a7e3');
    expect(r.yaml).not.toContain('hunter22');
    expect(why('agent', 'environment.API_TOKEN')?.reason).toContain('create the swarmy secret api-token');
    expect(why('agent', 'environment.REGION')?.reason).toContain('${REGION}');
  });

  it('says a database’s data and settings don’t move to the managed resource', () => {
    expect(why('db', 'volumes: pgdata:/var/lib/postgresql/data')?.reason).toContain('starts empty');
    expect(why('db', 'environment')).toBeDefined();
    expect(why('db', 'ports')).toBeDefined();
    expect(why('db', 'image: postgres:13')?.reason).toContain('starts on 16');
    expect(r.yaml).not.toContain('example');
    expect(parseAppConfig(r.yaml!).config?.resources).toEqual({ db: 'postgres', reports: { type: 'postgres', version: 15 } });
  });
});

describe('compose readers', () => {
  it('reads ports in every form', () => {
    expect(portsOf(['8080:3000', '127.0.0.1:9000:9000/udp', 3001, { target: 4000, published: 4400 }, 'junk'])).toEqual([
      { raw: '8080:3000', target: 3000, published: '8080' },
      { raw: '127.0.0.1:9000:9000/udp', target: 9000, published: '9000' },
      { raw: '3001', target: 3001 },
      { raw: '4400:4000', target: 4000, published: '4400' },
    ]);
  });

  it('reads volumes in the short and long forms', () => {
    expect(volumesOf(['data:/d', './x:/x:ro', '/anon', { type: 'bind', source: '/srv', target: '/srv' }, 'rel:path'])).toEqual([
      { raw: 'data:/d', source: 'data', target: '/d', bind: false },
      { raw: './x:/x:ro', source: './x', target: '/x', bind: true },
      { raw: '/anon', target: '/anon', bind: false },
      { raw: '/srv:/srv', source: '/srv', target: '/srv', bind: true },
    ]);
  });

  it('tells a credential from a setting', () => {
    expect(looksLikeCredential('DB_PASSWORD', 's3cr3t-pw')).toBe(true);
    expect(looksLikeCredential('PASSWORD_MIN_LENGTH', '12')).toBe(false);
    expect(looksLikeCredential('JWT_SECRET', '${JWT_SECRET}')).toBe(false);
    expect(looksLikeCredential('PUBLIC_URL', 'https://shop.example.com')).toBe(false);
    expect(looksLikeCredential('FEED', 'amqp://u:p4ss@mq:5672')).toBe(true);
    expect(secretNameFor('AWS_SECRET_ACCESS_KEY')).toBe('aws-secret-access-key');
    expect(secretNameFor('_9KEY')).toBe('s-9key');
  });
});
