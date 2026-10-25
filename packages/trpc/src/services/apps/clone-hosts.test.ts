import { describe, expect, it } from 'bun:test';
import { autoLabelFor } from '@swarmy/ingress';
import { cloneHostFor } from './clone-hosts';

describe('cloneHostFor — a clone’s stable per-environment address', () => {
  it('is the automatic-address name for the clone’s own stack under the org base', () => {
    const host = cloneHostFor('shop-qa', '1-2-3-4.sslip.io');
    expect(host('web')).toBe('web-shop-qa.1-2-3-4.sslip.io');
    expect(cloneHostFor('shop-qa', 'apps.northwind.dev')('web')).toBe('web-shop-qa.apps.northwind.dev');
  });

  it('stays one valid DNS label for a long name, the same one the address planner picks', () => {
    const stack = `shop-${'q'.repeat(20)}`;
    const svc = 'w'.repeat(50);
    const host = cloneHostFor(stack, 'apps.northwind.dev')(svc);
    const label = host.split('.')[0]!;
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toBe(autoLabelFor(stack, svc));
  });
});
