import { isOverride, MASKED_VALUE, type EnvLayerCell, type EnvLayers } from '@swarmy/app-config';

/**
 * Shared variables (boards Environments · AppVariables): one row per key,
 * the shared value, then each environment's — coral where that environment
 * overrides it. PURE — unit-tested; the layers come masked from the server.
 */
export const PRECEDENCE = 'service env › environments.<name>.env › shared env';

export interface SharedCell {
  text: string;
  /** This environment changes it (environments.<name>.env or its per-service override). */
  override: boolean;
  masked: boolean;
  /** Services that set their own value here, in words ("web sets its own"). */
  note: string | null;
}

const shown = (v: string | null): { text: string; masked: boolean } =>
  v === null ? { text: '—', masked: false } : v === MASKED_VALUE ? { text: 'masked', masked: true } : { text: v, masked: false };

export function sharedCell(cell: EnvLayerCell | undefined): SharedCell {
  if (!cell) return { text: '—', override: false, masked: false, note: null };
  const { text, masked } = shown(cell.value);
  const own = cell.services.map((s) => (s.layer === 'environment' ? `${s.service}: ${shown(s.value).text}` : `${s.service} sets its own`));
  return { text, override: isOverride(cell), masked, note: own.length ? own.join(' · ') : null };
}

export function sharedHead(v: string | null): { text: string; masked: boolean } {
  return shown(v);
}

/** "8 shared variables; staging overrides 2." */
export function sharedSentence(layers: EnvLayers): string {
  const n = layers.rows.length;
  if (n === 0) return 'swarmy.yaml sets no shared variables yet.';
  const overrides = layers.environments
    .map((e) => ({ e, k: layers.rows.filter((r) => isOverride(r.envs[e])).length }))
    .filter((x) => x.k > 0)
    .map((x) => `${x.e} overrides ${x.k}`);
  const head = `${n} shared variable${n === 1 ? '' : 's'}`;
  return overrides.length ? `${head}; ${overrides.join(', ')}.` : `${head}; no environment overrides any.`;
}
