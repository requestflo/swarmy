import { describe, expect, it } from 'bun:test';
import { toDesired } from './desired';
import { parseAppConfig } from './parse';

const YAML = `version: 1
app: shop
services:
  worker:
    image: ghcr.io/acme/worker:1
    env:
      QUEUE_URL: \${{ jobs.url }}
      QUEUE_PASSWORD_FILE: \${{ jobs.password_file }}
resources:
  jobs: queue
  mail: { type: queue, memory: 512mb, ha: replica, replicas: 1 }
`;

describe('swarmy.yaml queue resources', () => {
  it('parse and normalise to a BullMQ-purpose managed cache', () => {
    const r = parseAppConfig(YAML);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const d = toDesired(r.config!);
    const jobs = d.resources.find((x) => x.name === 'jobs');
    const mail = d.resources.find((x) => x.name === 'mail');
    expect(jobs).toMatchObject({ type: 'cache', purpose: 'queue', engine: 'valkey', ha: 'single', memoryMb: 256 });
    expect(mail).toMatchObject({ type: 'cache', purpose: 'queue', ha: 'replica', replicas: 1, memoryMb: 512 });
  });

  it('a queue and a cache with the same shape differ in signature', () => {
    const q = toDesired(parseAppConfig(YAML).config!).resources.find((x) => x.name === 'jobs')!;
    const c = toDesired(parseAppConfig(YAML.replace('jobs: queue', 'jobs: cache')).config!).resources.find(
      (x) => x.name === 'jobs',
    )!;
    expect(q.sig).not.toBe(c.sig);
  });

  it('rejects fields a queue does not expose', () => {
    const r = parseAppConfig(YAML.replace('${{ jobs.url }}', '${{ jobs.bucket }}'));
    expect(r.issues.some((i) => i.severity === 'error' && /jobs/.test(i.message))).toBe(true);
  });
});
