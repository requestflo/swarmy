import { describe, expect, test } from 'bun:test';
import type { InvService, QueueView } from '@swarmy/core';
import { isWorker, workerRows } from './workers-model';

const svc = (name: string, extra: Partial<InvService> = {}): InvService =>
  ({ id: name, name, stack: 'shop', ports: [], labels: {}, replicas: { desired: 1, running: 1 }, ...extra }) as InvService;
const queue = (name: string, workerService: string): QueueView => ({ name, workerService, workers: { desired: 2, running: 2 } }) as QueueView;

describe('workers', () => {
  test('no published port and no route; data members and canaries are not workers', () => {
    expect(isWorker(svc('shop_mailer'))).toBe(true);
    expect(isWorker(svc('shop_web', { ports: [{ target: 3000, published: 3000, protocol: 'tcp' }] }))).toBe(false);
    expect(isWorker(svc('shop_web', { labels: { 'swarmy.ingress.routes': '[{"host":"a.dev"}]' } }))).toBe(false);
    expect(isWorker(svc('shop_db-primary', { labels: { 'swarmy.db.role': 'primary' } }))).toBe(false);
    expect(isWorker(svc('shop_web--canary'))).toBe(false);
  });

  test('queues attach to their worker, even one the inventory hasn’t listed', () => {
    const rows = workerRows('shop', [svc('shop_mailer'), svc('shop_web', { ports: [{ target: 1, published: 80, protocol: 'tcp' }] })], [
      queue('emails', 'shop_mailer'),
      queue('carts', 'shop_mailer'),
      queue('thumbs', 'shop_media'),
    ]);
    expect(rows.map((r) => [r.part, r.queues.map((q) => q.name), r.copies.desired])).toEqual([
      ['mailer', ['emails', 'carts'], 1],
      ['media', ['thumbs'], 2],
    ]);
  });
});
