import { describe, expect, it } from 'bun:test';
import type { ResilienceProblemView } from '@swarmy/core';
import {
  buildDrillCards,
  buildResticCheckEnv,
  gradeFor,
  isUserService,
  resticRepoUrl,
  runChecks,
  scoreProblems,
  stackIsProduction,
  type ResilienceServiceSignal,
  type ResilienceSnapshot,
} from './resilience.service';

const NOW = '2026-07-02T12:00:00.000Z';
const daysAgo = (d: number): string =>
  new Date(new Date(NOW).getTime() - d * 86_400_000).toISOString();

function svc(over: Partial<ResilienceServiceSignal> = {}): ResilienceServiceSignal {
  return {
    name: 'web',
    stack: 'shop',
    mode: 'replicated',
    desired: 2,
    running: 2,
    scaleToZero: false,
    labels: {},
    ...over,
  };
}

/** A healthy estate: no problems fire (score 100). */
function healthySnapshot(over: Partial<ResilienceSnapshot> = {}): ResilienceSnapshot {
  return {
    now: NOW,
    services: [svc()],
    estateRegions: [],
    ingress: { enabled: true, instanceCount: 2 },
    storage: { enabled: true, replicationFactor: 3 },
    backups: { targetCount: 1, lastSuccessAt: daysAgo(0.2) },
    geodns: { enabled: false, recordRegions: [] },
    controllerBackup: { enabled: true, lastRunAt: daysAgo(1) },
    lastRestoreDrillAt: daysAgo(2),
    managers: { total: 3, reachable: 3 },
    ...over,
  };
}

const byCheck = (problems: ResilienceProblemView[], check: string): ResilienceProblemView[] =>
  problems.filter((p) => p.check === check);

describe('score math', () => {
  it('weights crit 15 / warn 7 / info 2 and floors at 0', () => {
    const p = (severity: 'crit' | 'warn' | 'info'): ResilienceProblemView => ({
      id: `x-${Math.random()}`,
      check: 'single-replica',
      severity,
      title: '',
      detail: '',
      fixHint: '',
      fixPath: '/services',
      fixLabel: '',
      resource: null,
    });
    expect(scoreProblems([], new Date(NOW)).score).toBe(100);
    expect(scoreProblems([p('crit')], new Date(NOW)).score).toBe(85);
    expect(scoreProblems([p('warn'), p('warn'), p('info'), p('info')], new Date(NOW)).score).toBe(82);
    const many = Array.from({ length: 8 }, () => p('crit'));
    expect(scoreProblems(many, new Date(NOW)).score).toBe(0);
  });

  it('formats the headline and counts severities', () => {
    const view = scoreProblems([], new Date(NOW));
    expect(view.headline).toBe('Production readiness: 100%');
    expect(view.counts).toEqual({ crit: 0, warn: 0, info: 0 });
    expect(view.generatedAt).toBe(NOW);
  });

  it('maps scores to grades at the documented boundaries', () => {
    expect(gradeFor(100)).toBe('A');
    expect(gradeFor(90)).toBe('A');
    expect(gradeFor(89)).toBe('B');
    expect(gradeFor(80)).toBe('B');
    expect(gradeFor(79)).toBe('C');
    expect(gradeFor(65)).toBe('C');
    expect(gradeFor(64)).toBe('D');
    expect(gradeFor(50)).toBe('D');
    expect(gradeFor(49)).toBe('F');
    expect(gradeFor(0)).toBe('F');
  });
});

describe('isUserService — which services count as user apps', () => {
  it('accepts a plain replicated app', () => {
    expect(isUserService(svc())).toBe(true);
  });
  it('rejects global, scale-to-zero, swarmy-owned and managed-data services', () => {
    expect(isUserService(svc({ mode: 'global' }))).toBe(false);
    expect(isUserService(svc({ scaleToZero: true }))).toBe(false);
    expect(isUserService(svc({ name: 'swarmy-garage' }))).toBe(false);
    expect(isUserService(svc({ labels: { 'swarmy.managed': 'true' } }))).toBe(false);
    expect(isUserService(svc({ labels: { 'swarmy.db.cluster': 'main' } }))).toBe(false);
    expect(isUserService(svc({ labels: { 'swarmy.cache.role': 'primary' } }))).toBe(false);
  });
});

describe('runChecks — classifiers', () => {
  it('a healthy estate scores 100 (no problems)', () => {
    expect(runChecks(healthySnapshot())).toEqual([]);
  });

  it('single-replica user services aggregate into one warn', () => {
    const problems = runChecks(
      healthySnapshot({
        services: [
          svc({ name: 'grafana', desired: 1 }),
          svc({ name: 'prometheus', desired: 1 }),
          svc({ name: 'web', desired: 3 }),
        ],
      }),
    );
    const hits = byCheck(problems, 'single-replica');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe('warn');
    expect(hits[0]!.title).toContain('2 services');
    expect(hits[0]!.resource).toBe('grafana, prometheus');
  });

  it('managed cache with single topology warns per cluster', () => {
    const problems = runChecks(
      healthySnapshot({
        services: [
          svc({
            name: 'platform_sessions-cache',
            stack: 'platform',
            labels: {
              'swarmy.cache.role': 'primary',
              'swarmy.cache.cluster': 'sessions',
              'swarmy.cache.topology': 'single',
            },
          }),
          svc({
            name: 'shop_main-cache',
            labels: {
              'swarmy.cache.role': 'primary',
              'swarmy.cache.cluster': 'main',
              'swarmy.cache.topology': 'sentinel',
            },
          }),
        ],
      }),
    );
    const hits = byCheck(problems, 'cache-no-replica');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.resource).toBe('platform/sessions');
  });

  it('db single topology is crit in production, info elsewhere', () => {
    const anchor = (stack: string): ResilienceServiceSignal =>
      svc({
        name: `${stack}_main-primary`,
        stack,
        labels: {
          'swarmy.db.cluster': 'main',
          'swarmy.db.role': 'primary',
          'swarmy.db.topology': 'single',
          'swarmy.db.replicas': '0',
        },
      });
    const prodMarker = svc({ name: 'api', stack: 'prod', labels: { 'swarmy.env': 'production' } });

    const prod = byCheck(
      runChecks(healthySnapshot({ services: [anchor('prod'), prodMarker] })),
      'db-topology',
    );
    expect(prod).toHaveLength(1);
    expect(prod[0]!.severity).toBe('crit');

    const dev = byCheck(runChecks(healthySnapshot({ services: [anchor('dev')] })), 'db-topology');
    expect(dev).toHaveLength(1);
    expect(dev[0]!.severity).toBe('info');
  });

  it('a replicated topology with declared replicas stays quiet', () => {
    const problems = runChecks(
      healthySnapshot({
        services: [
          svc({
            name: 'shop_main-primary',
            labels: {
              'swarmy.db.cluster': 'main',
              'swarmy.db.role': 'primary',
              'swarmy.db.topology': 'primary-replica',
              'swarmy.db.replicas': '2',
            },
          }),
        ],
      }),
    );
    expect(byCheck(problems, 'db-topology')).toHaveLength(0);
  });

  it('storage replication below 3 warns; disabled store stays quiet', () => {
    const low = runChecks(healthySnapshot({ storage: { enabled: true, replicationFactor: 1 } }));
    expect(byCheck(low, 'storage-replication')).toHaveLength(1);
    const off = runChecks(healthySnapshot({ storage: { enabled: false, replicationFactor: 1 } }));
    expect(byCheck(off, 'storage-replication')).toHaveLength(0);
  });

  it('backup recency: no destination and stale backups are crit', () => {
    const none = runChecks(
      healthySnapshot({ backups: { targetCount: 0, lastSuccessAt: null } }),
    );
    expect(byCheck(none, 'backup-recency')[0]?.severity).toBe('crit');

    const stale = runChecks(
      healthySnapshot({ backups: { targetCount: 1, lastSuccessAt: daysAgo(8) } }),
    );
    expect(byCheck(stale, 'backup-recency')[0]?.title).toContain('7 days');

    const fresh = runChecks(
      healthySnapshot({ backups: { targetCount: 1, lastSuccessAt: daysAgo(1) } }),
    );
    expect(byCheck(fresh, 'backup-recency')).toHaveLength(0);
  });

  it('restore-untested warns only when backups exist and no drill passed', () => {
    const untested = runChecks(healthySnapshot({ lastRestoreDrillAt: null }));
    expect(byCheck(untested, 'restore-untested')).toHaveLength(1);
    const noBackups = runChecks(
      healthySnapshot({
        backups: { targetCount: 1, lastSuccessAt: null },
        lastRestoreDrillAt: null,
      }),
    );
    expect(byCheck(noBackups, 'restore-untested')).toHaveLength(0);
  });

  it('single-node ingress warns; disabled ingress stays quiet', () => {
    const single = runChecks(healthySnapshot({ ingress: { enabled: true, instanceCount: 1 } }));
    expect(byCheck(single, 'ingress-single')).toHaveLength(1);
    const off = runChecks(healthySnapshot({ ingress: { enabled: false, instanceCount: 0 } }));
    expect(byCheck(off, 'ingress-single')).toHaveLength(0);
  });

  it('geodns single region is info only on a multi-region estate', () => {
    const multi = runChecks(
      healthySnapshot({
        estateRegions: ['us-east', 'eu-west'],
        geodns: { enabled: true, recordRegions: ['us-east'] },
      }),
    );
    expect(byCheck(multi, 'geodns-single-region')[0]?.severity).toBe('info');

    const covered = runChecks(
      healthySnapshot({
        estateRegions: ['us-east', 'eu-west'],
        geodns: { enabled: true, recordRegions: ['us-east', 'eu-west'] },
      }),
    );
    expect(byCheck(covered, 'geodns-single-region')).toHaveLength(0);

    const singleRegionEstate = runChecks(
      healthySnapshot({ estateRegions: ['us-east'], geodns: { enabled: false, recordRegions: [] } }),
    );
    expect(byCheck(singleRegionEstate, 'geodns-single-region')).toHaveLength(0);
  });

  it('controller backup off or stale warns', () => {
    const off = runChecks(
      healthySnapshot({ controllerBackup: { enabled: false, lastRunAt: null } }),
    );
    expect(byCheck(off, 'controller-backup')[0]?.title).toBe('Controller backups are off');
    const stale = runChecks(
      healthySnapshot({ controllerBackup: { enabled: true, lastRunAt: daysAgo(10) } }),
    );
    expect(byCheck(stale, 'controller-backup')[0]?.title).toContain('older than');
  });

  it('sorts problems crit → warn → info', () => {
    const problems = runChecks(
      healthySnapshot({
        services: [
          svc({ name: 'solo', desired: 1 }),
          svc({
            name: 'prod_main-primary',
            stack: 'prod',
            labels: {
              'swarmy.db.cluster': 'main',
              'swarmy.db.role': 'primary',
              'swarmy.db.topology': 'single',
              'swarmy.env': 'production',
            },
          }),
        ],
        estateRegions: ['us-east', 'eu-west'],
      }),
    );
    const severities = problems.map((p) => p.severity);
    expect(severities).toEqual([...severities].sort((a, b) => {
      const order = { crit: 0, warn: 1, info: 2 } as const;
      return order[a] - order[b];
    }));
    expect(severities[0]).toBe('crit');
  });
});

describe('runChecks — swarm manager quorum (WS2)', () => {
  const quorum = (total: number, reachable: number) =>
    runChecks(healthySnapshot({ managers: { total, reachable } }));

  it('a single manager is an info (SPOF), never a quorum crit', () => {
    const problems = quorum(1, 1);
    expect(byCheck(problems, 'swarm-single-manager')).toHaveLength(1);
    expect(byCheck(problems, 'swarm-single-manager')[0]!.severity).toBe('info');
    expect(byCheck(problems, 'swarm-even-managers')).toHaveLength(0);
    expect(byCheck(problems, 'swarm-quorum-risk')).toHaveLength(0);
  });

  it('even manager counts warn with the odd-count advice', () => {
    for (const total of [2, 4, 6]) {
      const problems = byCheck(quorum(total, total), 'swarm-even-managers');
      expect(problems).toHaveLength(1);
      expect(problems[0]!.severity).toBe('warn');
      expect(problems[0]!.detail).toContain('1, 3, 5 or 7');
    }
    for (const total of [1, 3, 5, 7]) {
      expect(byCheck(quorum(total, total), 'swarm-even-managers')).toHaveLength(0);
    }
  });

  it('healthy odd manager sets (3/5/7 all reachable) raise no quorum risk', () => {
    for (const total of [3, 5, 7]) {
      expect(byCheck(quorum(total, total), 'swarm-quorum-risk')).toHaveLength(0);
    }
  });

  it('crits when reachable managers sit exactly at the majority', () => {
    // (total, reachable at floor(n/2)+1): one more failure loses quorum.
    const atMajority: Array<[number, number]> = [
      [2, 2],
      [3, 2],
      [4, 3],
      [5, 3],
      [6, 4],
      [7, 4],
    ];
    for (const [total, reachable] of atMajority) {
      const problems = byCheck(quorum(total, reachable), 'swarm-quorum-risk');
      expect(problems).toHaveLength(1);
      expect(problems[0]!.severity).toBe('crit');
      expect(problems[0]!.title).toBe('One manager failure from losing quorum');
    }
  });

  it('names the offline manager count in the at-risk fix text', () => {
    const [p] = byCheck(quorum(3, 2), 'swarm-quorum-risk');
    expect(p!.detail).toBe('You have 3 managers but 1 is offline — one more failure loses quorum.');
  });

  it('crits as lost when reachable managers fall below the majority', () => {
    const belowMajority: Array<[number, number]> = [
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
      [6, 3],
      [7, 3],
      [3, 0],
    ];
    for (const [total, reachable] of belowMajority) {
      const problems = byCheck(quorum(total, reachable), 'swarm-quorum-risk');
      expect(problems).toHaveLength(1);
      expect(problems[0]!.severity).toBe('crit');
      expect(problems[0]!.title).toBe('Swarm quorum is lost');
    }
  });

  it('reachable above the majority raises nothing (5 managers, 1 offline)', () => {
    expect(byCheck(quorum(5, 4), 'swarm-quorum-risk')).toHaveLength(0);
    expect(byCheck(quorum(7, 6), 'swarm-quorum-risk')).toHaveLength(0);
    expect(byCheck(quorum(7, 5), 'swarm-quorum-risk')).toHaveLength(0);
  });

  it('an empty estate (no swarm yet) raises no quorum findings', () => {
    const problems = quorum(0, 0);
    expect(byCheck(problems, 'swarm-single-manager')).toHaveLength(0);
    expect(byCheck(problems, 'swarm-even-managers')).toHaveLength(0);
    expect(byCheck(problems, 'swarm-quorum-risk')).toHaveLength(0);
  });
});

describe('stackIsProduction', () => {
  it('reads the swarmy.env label off any service in the stack', () => {
    const services = [
      svc({ name: 'api', stack: 'prod', labels: { 'swarmy.env': 'production' } }),
      svc({ name: 'db', stack: 'prod' }),
    ];
    expect(stackIsProduction(services, 'prod')).toBe(true);
    expect(stackIsProduction(services, 'other')).toBe(false);
  });
});

describe('buildDrillCards — availability + RPO/RTO derivation', () => {
  const target = {
    stack: 'shop',
    cluster: 'main',
    topology: 'primary-replica',
    healthy: true,
    replicasRunning: 1,
  };

  it('derives RPO from backup age and RTO from the last passed restore drill', () => {
    const cards = buildDrillCards(
      healthySnapshot({ backups: { targetCount: 1, lastSuccessAt: daysAgo(0.5) } }),
      [target],
      [
        {
          kind: 'restore',
          status: 'passed',
          at: daysAgo(2),
          durationMs: 480_000,
          target: 'shop/main',
          summary: '',
          steps: [],
          error: null,
        },
      ],
    );
    const restore = cards.find((c) => c.kind === 'restore')!;
    expect(restore.available).toBe(true);
    expect(restore.rpoSeconds).toBe(43_200);
    expect(restore.rtoEstimateMs).toBe(480_000);
  });

  it('gates each drill on its preconditions', () => {
    const cards = buildDrillCards(
      healthySnapshot({ backups: { targetCount: 0, lastSuccessAt: null } }),
      [],
      [],
    );
    expect(cards.find((c) => c.kind === 'restore')!.available).toBe(false);
    expect(cards.find((c) => c.kind === 'backup-verify')!.available).toBe(false);
    expect(cards.find((c) => c.kind === 'failover')!.available).toBe(false);

    const withUnhealthy = buildDrillCards(
      healthySnapshot(),
      [{ ...target, replicasRunning: 0 }],
      [],
    );
    expect(withUnhealthy.find((c) => c.kind === 'failover')!.available).toBe(false);
    const withHealthy = buildDrillCards(healthySnapshot(), [target], []);
    expect(withHealthy.find((c) => c.kind === 'failover')!.available).toBe(true);
  });
});

describe('restic check plumbing (pure codecs)', () => {
  it('builds the repo URL for s3 and node kinds', () => {
    expect(resticRepoUrl('S3', 'https://s3.eu.example.com/', 'backups', '/org1')).toBe(
      's3:https://s3.eu.example.com/backups/org1',
    );
    expect(resticRepoUrl('node', null, '/var/backups/', 'swarmy')).toBe('/var/backups/swarmy');
  });

  it('builds the restic env with only the credentials that exist', () => {
    expect(
      buildResticCheckEnv({ repo: 's3:x/y', password: 'pw', accessKeyId: 'ak', secretAccessKey: 'sk', region: 'eu' }),
    ).toEqual({
      RESTIC_REPOSITORY: 's3:x/y',
      RESTIC_PASSWORD: 'pw',
      AWS_ACCESS_KEY_ID: 'ak',
      AWS_SECRET_ACCESS_KEY: 'sk',
      AWS_DEFAULT_REGION: 'eu',
    });
    expect(buildResticCheckEnv({ repo: '/data', password: 'pw' })).toEqual({
      RESTIC_REPOSITORY: '/data',
      RESTIC_PASSWORD: 'pw',
    });
  });
});
