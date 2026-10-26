import { describe, expect, it } from 'bun:test';
import { MIB } from '@/components/service-settings/settings-model';
import { copyMonthlyUsd, sizeCostBasis, sizeCostLine, usdWords } from './size-cost';

const nodes = [
  { nodeId: 'a', monthlyUsd: 8, memGb: 1 }, // $8/GB
  { nodeId: 'b', monthlyUsd: 32, memGb: 8 }, // $4/GB
  { nodeId: 'c', monthlyUsd: null, memGb: 16 },
  { nodeId: 'd', monthlyUsd: 40, memGb: 4 }, // $10/GB
];

describe('sizeCostBasis', () => {
  it('averages the priced servers the copies run on', () => {
    expect(sizeCostBasis(nodes, ['a', 'b', 'c'])).toEqual({ usdPerGb: 6, servers: 2, scope: 'these' });
  });
  it('falls back to every priced server when none of its own is priced', () => {
    expect(sizeCostBasis(nodes, ['c'])).toEqual({ usdPerGb: 22 / 3, servers: 3, scope: 'priced' });
  });
  it('has no price without a priced server, never a guess', () => {
    expect(sizeCostBasis([{ nodeId: 'c', monthlyUsd: null, memGb: 16 }], ['c'])).toBeNull();
    expect(sizeCostBasis([{ nodeId: 'x', monthlyUsd: 10, memGb: null }], ['x'])).toBeNull();
  });
});

describe('the cost line', () => {
  const basis = { usdPerGb: 8, servers: 2, scope: 'these' as const };
  it('says what a copy and every copy cost a month', () => {
    expect(copyMonthlyUsd(basis, 512 * MIB)).toBe(4);
    expect(sizeCostLine(basis, { cpus: 1, memoryBytes: 512 * MIB }, 1)).toBe('1 CPU · 512 MB ≈ $4/mo a copy on these servers.');
    expect(sizeCostLine(basis, { cpus: 1, memoryBytes: 512 * MIB }, 3)).toBe('1 CPU · 512 MB ≈ $4/mo a copy on these servers, $12/mo for all 3.');
  });
  it('says nothing without a memory ceiling or a price', () => {
    expect(sizeCostLine(basis, { cpus: 1 }, 1)).toBeNull();
    expect(sizeCostLine(null, { memoryBytes: 512 * MIB }, 1)).toBeNull();
  });
  it('rounds like money', () => {
    expect(usdWords(41.6)).toBe('$42');
    expect(usdWords(4.46)).toBe('$4.5');
    expect(usdWords(0.625)).toBe('$0.63');
  });
});
