import { describe, expect, it } from 'bun:test';
import { composeServices } from './compose-facts';
import { scanFile } from './files';
import { atTime, everyToCron, wheneverJobs } from './whenever';

const COMPOSE = `version: "3.9"
services:
  web:
    build: .
    command: ["node", "dist/server.js"]
    environment:
      - DATABASE_URL=postgres://app:app@db:5432/app
      - REDIS_URL
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: app
  cleanup:
    image: ghcr.io/northwind/tools:1.4
    command:
      - node
      - cleanup.js
    deploy:
      labels:
        swarm.cronjob.schedule: "0 3 * * *"
      replicas: 0
volumes:
  pgdata:
`;

describe('composeServices: a compose file, line by line', () => {
  const [web, db, cleanup] = composeServices(scanFile('docker-compose.yml', COMPOSE));

  it('names every service with its image, build and one-line command', () => {
    expect([web?.name, db?.name, cleanup?.name]).toEqual(['web', 'db', 'cleanup']);
    expect(web).toMatchObject({ build: { line: 4 }, command: { value: 'node dist/server.js', ev: { line: 5 } } });
    expect(db?.image).toMatchObject({ value: 'postgres:16-alpine', ev: { file: 'docker-compose.yml', line: 10 } });
    expect(cleanup?.command?.value).toBe('node cleanup.js');
  });

  it('reads environment and labels in list and map form, deploy.labels included', () => {
    expect(web?.env.map((e) => [e.name, e.value])).toEqual([['DATABASE_URL', 'postgres://app:app@db:5432/app'], ['REDIS_URL', '']]);
    expect(db?.env.map((e) => e.name)).toEqual(['POSTGRES_PASSWORD']);
    expect(cleanup?.labels).toEqual([{ name: 'swarm.cronjob.schedule', value: '0 3 * * *', ev: { file: 'docker-compose.yml', line: 20, text: 'swarm.cronjob.schedule: "0 3 * * *"' } }]);
  });

  it('a probe cut mid-file still reads what came before the cut', () => {
    const cut = composeServices(scanFile('compose.yaml', COMPOSE.slice(0, COMPOSE.indexOf('  cleanup:') + 20)));
    expect(cut.map((s) => s.name)).toEqual(['web', 'db', 'cleanup']);
    expect(cut[1]?.image?.value).toBe('postgres:16-alpine');
  });
});

describe('whenever: config/schedule.rb → cron lines', () => {
  it('reads the common every forms', () => {
    expect(everyToCron("1.day, at: '4:30 am'")).toBe('30 4 * * *');
    expect(everyToCron(":day, at: '12:20am'")).toBe('20 0 * * *');
    expect(everyToCron(':hour')).toBe('0 * * * *');
    expect(everyToCron('10.minutes')).toBe('*/10 * * * *');
    expect(everyToCron('3.hours')).toBe('0 */3 * * *');
    expect(everyToCron(":sunday, at: '12pm'")).toBe('0 12 * * 0');
    expect(everyToCron("'0 0 27-31 * *'")).toBe('0 0 27-31 * *');
  });

  it('skips forms it cannot say as a schedule', () => {
    expect(everyToCron(':reboot')).toBeNull();
    expect(everyToCron('2.weeks')).toBeNull();
    expect(everyToCron(":day, at: 'noonish'")).toBeNull();
    expect(atTime('25:00')).toBeNull();
  });

  it('pairs each block with its rake / runner / command line', () => {
    const f = scanFile(
      'config/schedule.rb',
      "every 1.day, at: '4:30 am' do\n  rake \"invoices:send\"\nend\n\nevery :reboot do\n  command \"x\"\nend\nevery :hour do\n  runner \"Cleanup.run\"\nend\n",
    );
    expect(wheneverJobs(f).map((j) => [j.schedule, j.command, j.hint, j.line.no])).toEqual([
      ['30 4 * * *', 'bundle exec rake invoices:send', 'send', 1],
      ['0 * * * *', 'bundle exec rails runner "Cleanup.run"', 'Cleanup', 8],
    ]);
  });
});
