import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo resolvers for checkout funnels (`rum.getFunnels` / `setFunnels` /
 * `funnel`). The storefront ships one Checkout funnel whose pay step got
 * worse with the v1.9.0 canary (releases: rel-store-6, 20 min ago), the
 * release the Apple Pay error came in with (errors-issues), so the card reads
 * "Biggest drop: checkout → paid, since v1.9.0" with "See the error". The
 * "since" uses the server's rule (≥ 20 entrants a side, ≥ 5 pts, z ≥ 1.96),
 * so the thin signed-in split honestly says no more than the drop.
 */

interface Step { name?: string; path: string; event?: string }
interface Funnel { id: string; name: string; steps: Step[]; windowMinutes: number }
interface Release { id: string; stackName: string; createdAt: string; images: Array<{ image: string }> }

const CHECKOUT: Funnel = {
  id: 'checkout', name: 'Checkout', windowMinutes: 60,
  steps: [{ name: 'product', path: '/product/*' }, { path: '/cart' }, { path: '/checkout' }, { name: 'paid', path: '/checkout/*', event: 'paid' }],
};

/** Visits at product → cart → checkout → paid under each storefront release ('' = before the oldest one). */
const PER_RELEASE: Record<string, number[]> = {
  'rel-store-6': [52, 38, 26, 8],
  'rel-store-5': [610, 446, 318, 186],
  'rel-store-4': [9, 7, 5, 3],
  'rel-store-3': [1530, 1101, 780, 456],
  'rel-store-2': [1160, 841, 590, 341],
  '': [419, 300, 211, 122],
};

const stepName = (s: Step): string => s.name || s.event || s.path.split('/').filter((p) => p && !p.includes('*')).at(-1) || 'home';

function funnels(s: DemoStore, stack: string): Funnel[] {
  const all = (s.extra.rumFunnels ??= { storefront: [CHECKOUT] }) as Record<string, Funnel[]>;
  return all[stack] ?? [];
}

function counts(f: Funnel, days: number, signedIn: boolean): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const scale = (id: string) => (signedIn ? 0.015 : 1) * (id === '' ? Math.max(1, (days * 24 - 149) / 19) : 1);
  for (const [id, base] of Object.entries(PER_RELEASE)) {
    const v = f.id === CHECKOUT.id ? base : f.steps.map((_, i) => Math.round(base[0]! * 0.62 ** i));
    out.set(id, f.steps.map((_, i) => Math.round((v[i] ?? 0) * scale(id))));
  }
  return out;
}

/** The server's "since" rule, over the drop's two steps per release (oldest first). */
function since(order: string[], by: Map<string, number[]>, k: number): { id: string; before: number; after: number } | null {
  let best: { id: string; before: number; after: number; z: number } | null = null;
  for (let b = 1; b < order.length; b++) {
    const side = (ids: string[]) => ids.reduce((a, id) => ({ r: a.r + by.get(id)![k - 1]!, c: a.c + by.get(id)![k]! }), { r: 0, c: 0 });
    const x = side(order.slice(0, b));
    const y = side(order.slice(b));
    if (x.r < 20 || y.r < 20) continue;
    const p = (x.c + y.c) / (x.r + y.r);
    const z = (x.c / x.r - y.c / y.r) / Math.sqrt(p * (1 - p) * (1 / x.r + 1 / y.r));
    if (x.c / x.r - y.c / y.r < 0.05 || z < 1.96) continue;
    if (!best || z > best.z) best = { id: order[b]!, before: x.c / x.r, after: y.c / y.r, z };
  }
  return best;
}

function funnelView(s: DemoStore, input: { stack: string; funnel: string; days?: number; signedIn?: boolean }) {
  const days = input.days ?? 7;
  const f = funnels(s, input.stack).find((x) => x.id === input.funnel);
  const identified = (s.extra.rum as { settings: Record<string, { mode: string }> }).settings[input.stack]?.mode === 'identified';
  const signedIn = Boolean(input.signedIn) && identified;
  const base = { days, audience: signedIn ? 'signed-in' : 'visits', biggestDrop: null, since: null, releases: [] };
  const named = (f?.steps ?? []).map((x) => ({ name: stepName(x), path: x.path, event: x.event ?? null }));
  if (!f) return { ...base, status: 'no-funnel', funnel: null, steps: [] };
  const meta = { id: f.id, name: f.name, windowMinutes: f.windowMinutes };
  const on = input.stack === 'storefront';
  const by = on ? counts(f, days, signedIn) : new Map<string, number[]>();
  const total = named.map((_, i) => [...by.values()].reduce((a, v) => a + v[i]!, 0));
  const steps = named.map((x, i) => {
    const conversion = i === 0 ? 1 : total[i - 1] ? total[i]! / total[i - 1]! : 0;
    return { ...x, visitors: total[i]!, conversion, dropOff: 1 - conversion };
  });
  const k = steps.reduce((w, x, i) => (i > 0 && total[i - 1]! >= 10 && x.dropOff > (w ? steps[w]!.dropOff : 0) ? i : w), 0);
  if (!k) return { ...base, status: 'ok', funnel: meta, steps };
  const rels = ((s.extra.releases as { releases: Release[] }).releases ?? []).filter((r) => r.stackName === input.stack);
  const ref = (id: string) => {
    const r = rels.find((x) => x.id === id);
    return { releaseId: id, image: r?.images[0]?.image ?? null, at: r?.createdAt ?? null };
  };
  const order = ['', ...rels.map((r) => r.id).filter((id) => by.has(id)).reverse()];
  const found = since(order, by, k);
  return {
    ...base,
    status: 'ok',
    funnel: meta,
    steps,
    biggestDrop: { index: k, from: steps[k - 1]!.name, to: steps[k]!.name, dropOff: steps[k]!.dropOff, lost: total[k - 1]! - total[k]! },
    since: found ? { ...ref(found.id), before: found.before, after: found.after } : null,
    releases: [...order].reverse().map((id) => ({ ...ref(id), entered: by.get(id)![0]!, reached: by.get(id)![k - 1]!, converted: by.get(id)![k]! })),
  };
}

export const rumFunnel: DomainResolvers = {
  handlers: {
    'rum.getFunnels': (i, s) => {
      const { stack } = i as { stack: string };
      return { stack, funnels: funnels(s, stack) };
    },
    'rum.setFunnels': (i, s) => {
      const { stack, funnels: next } = i as { stack: string; funnels: Array<Omit<Funnel, 'windowMinutes'> & { windowMinutes?: number }> };
      funnels(s, stack);
      const clean = next.map((f) => ({ ...f, windowMinutes: f.windowMinutes ?? 60, steps: f.steps.map((x) => ({ ...x, path: x.path.length > 1 ? x.path.replace(/\/$/, '') : x.path })) }));
      (s.extra.rumFunnels as Record<string, Funnel[]>)[stack] = clean;
      return { stack, funnels: clean };
    },
    'rum.funnel': (i, s) => funnelView(s, i as { stack: string; funnel: string; days?: number; signedIn?: boolean }),
  },
};
