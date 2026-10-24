import type { DemoHandler } from '../types';

/**
 * Settings › Platform › Import release › Bundle, in the demo: chunks are
 * counted, then each status poll copies a few more of the release's images
 * until it is done. Mirrors BundleUploadView (platform-bundle.service.ts).
 */
interface DemoBundle {
  id: string;
  name: string;
  size: number;
  received: number;
  phase: 'receiving' | 'loading' | 'done' | 'failed';
  version?: string;
  total?: number;
  done?: number;
  current?: string | null;
  error: string | null;
}

const IMAGES = ['controller', 'agent', 'caddySwarmy', 'dns', 'garage', 'registry', 'otelCollector', 'clickhouse'];
const CHUNK = 8 * 1024 * 1024;
let current: DemoBundle | null = null;

const view = () => (current ? { ...current } : null);

export const bundleResolvers: Record<string, DemoHandler> = {
  'platform.bundle.begin': (i) => {
    const { name, size } = i as { name: string; size: number };
    current = { id: '00000000-0000-4000-8000-000000000001', name, size, received: 0, phase: 'receiving', error: null };
    return { ...view(), chunkBytes: CHUNK };
  },
  'platform.bundle.chunk': (i) => {
    const { offset, data } = i as { offset: number; data: string };
    if (current) current.received = Math.min(current.size, offset + Math.floor((data.length * 3) / 4));
    return view();
  },
  'platform.bundle.finish': () => {
    if (current) Object.assign(current, { phase: 'loading', version: '1.3.0', total: IMAGES.length, done: 0, current: IMAGES[0] });
    return view();
  },
  'platform.bundle.status': () => {
    if (current?.phase === 'loading') {
      const done = Math.min(IMAGES.length, (current.done ?? 0) + 3);
      Object.assign(current, done >= IMAGES.length ? { phase: 'done', done, current: null } : { done, current: IMAGES[done] });
    }
    return view();
  },
};
