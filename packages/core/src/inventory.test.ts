import { expect, test } from 'bun:test';
import { buildInventory, STACK_LABEL, UNGROUPED } from './inventory';
import type { ContainerInfo, SwarmServiceInfo } from './protocol';

function svc(p: Partial<SwarmServiceInfo> & { id: string; name: string }): SwarmServiceInfo {
  return {
    id: p.id,
    name: p.name,
    image: p.image ?? 'img:1',
    mode: p.mode ?? 'replicated',
    desiredReplicas: p.desiredReplicas ?? 1,
    runningReplicas: p.runningReplicas ?? 1,
    createdAt: 0,
    updatedAt: 0,
    labels: p.labels ?? {},
    networks: p.networks ?? [],
    env: p.env ?? [],
    ports: p.ports ?? [],
    secrets: p.secrets ?? [],
    configs: p.configs ?? [],
  };
}

test('groups services by docker stack namespace; ungrouped sorts last', () => {
  const inv = buildInventory(
    [
      svc({ id: 'a', name: 'web', labels: { [STACK_LABEL]: 'shop' } }),
      svc({ id: 'b', name: 'loner' }),
      svc({ id: 'c', name: 'api', labels: { [STACK_LABEL]: 'shop' } }),
    ],
    [],
  );
  expect(inv.projects.map((p) => p.name)).toEqual(['shop', UNGROUPED]);
  expect(inv.projects[0]!.serviceIds.sort()).toEqual(['a', 'c']);
});

test('infers a network edge between services sharing a non-system overlay net', () => {
  const inv = buildInventory(
    [
      svc({ id: 'a', name: 'web', networks: [{ name: 'app', aliases: [] }, { name: 'ingress', aliases: [] }] }),
      svc({ id: 'b', name: 'api', networks: [{ name: 'app', aliases: [] }] }),
      svc({ id: 'c', name: 'lonely', networks: [{ name: 'ingress', aliases: [] }] }),
    ],
    [],
  );
  const netEdges = inv.edges.filter((e) => e.kind === 'network');
  expect(netEdges).toHaveLength(1); // ingress is a system net → ignored
  expect([netEdges[0]!.from, netEdges[0]!.to].sort()).toEqual(['a', 'b']);
});

test('infers a depends edge from an env reference to another service name', () => {
  const inv = buildInventory(
    [
      svc({ id: 'a', name: 'api', env: ['DATABASE_URL=postgres://user@postgres:5432/db'] }),
      svc({ id: 'b', name: 'postgres' }),
    ],
    [],
  );
  const dep = inv.edges.find((e) => e.kind === 'depends');
  expect(dep).toBeTruthy();
  expect(dep!.from).toBe('a');
  expect(dep!.to).toBe('b');
});

test('attaches containers and marks scale-to-zero idle', () => {
  const containers: ContainerInfo[] = [
    { id: 'ct1', name: 'web.1', image: 'img:1', state: 'running', status: 'Up', createdAt: 0, ports: [], labels: {}, serviceId: 'a' },
  ];
  const inv = buildInventory(
    [
      svc({ id: 'a', name: 'web', runningReplicas: 1 }),
      svc({ id: 'z', name: 'cold', desiredReplicas: 0, runningReplicas: 0, labels: { 'swarmy.scaleToZero.enabled': 'true' } }),
    ],
    containers,
  );
  expect(inv.services.find((s) => s.id === 'a')!.containers).toHaveLength(1);
  const cold = inv.services.find((s) => s.id === 'z')!;
  expect(cold.status).toBe('idle');
  expect(cold.scaleToZero).toBe(true);
});
