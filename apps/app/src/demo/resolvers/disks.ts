import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo resolvers for a server's Disks card (`disks.list` / `disks.format`,
 * shape `NodeDisksView` in packages/trpc/src/services/disks.service.ts). Every
 * server has its system disk; wkr-1 also has a blank volume its provider
 * attached, which "Format and use" turns into swarmy's data disk.
 */

const GB = 1024 ** 3;
const KEY = 'disksFormatted';

function system(name: string) {
  return {
    name: 'vda',
    path: '/dev/vda',
    sizeBytes: 80 * GB,
    serial: null,
    model: null,
    state: 'system' as const,
    mountpoints: ['/'],
    fstype: 'ext4',
    label: null,
    reason: `The disk ${name} runs from.`,
    id: null,
    fsTotalBytes: 80 * GB,
    growableBytes: 0,
    isDefault: false,
  };
}

function attached(formatted: boolean) {
  return {
    name: 'sdb',
    path: '/dev/sdb',
    sizeBytes: 100 * GB,
    serial: 'DO-VOL-8F3A21C4',
    model: 'Volume',
    state: formatted ? ('swarmy' as const) : ('blank' as const),
    mountpoints: formatted ? ['/var/lib/swarmy/disks/8f3a21c4'] : [],
    fstype: formatted ? 'ext4' : null,
    label: formatted ? 'swarmy-8f3a21c4' : null,
    reason: formatted ? 'Set up by swarmy; new data goes here.' : 'Blank: no partitions or filesystem. Swarmy can format it.',
    id: formatted ? '8f3a21c4' : null,
    fsTotalBytes: formatted ? 98 * GB : null,
    growableBytes: 0,
    isDefault: formatted,
  };
}

function view(nodeId: string, s: DemoStore) {
  const node = s.nodes.find((n) => n.id === nodeId);
  const name = node?.name ?? nodeId;
  const disks = [system(name), ...(name === 'wkr-1' ? [attached(s.extra[KEY] === true)] : [])];
  return { nodeId, formatAllowed: true, formatBlockedReason: null, disks, warnings: [], lastRepair: null };
}

export const disks: DomainResolvers = {
  handlers: {
    'disks.list': (i, s) => view((i as { nodeId: string }).nodeId, s),
    'disks.format': (_i, s) => {
      s.extra[KEY] = true;
      return { mountpoint: '/var/lib/swarmy/disks/8f3a21c4' };
    },
  },
};
