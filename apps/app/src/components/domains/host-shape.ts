import type { WwwMode } from '@/components/ingress/domain-state';

/**
 * The shape of a hostname, for the live chips on "Add a domain". Mirrors
 * `apexOf` / `companionHost` in @swarmy/ingress (the app doesn't bundle that
 * package); the controller's `ingress.domainPlan` answer is the authority
 * once it settles.
 */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'co.za', 'org.za', 'com.au', 'net.au', 'org.au',
  'co.nz', 'org.nz', 'com.br', 'co.jp', 'co.in', 'com.mx', 'com.sg', 'com.tr', 'co.kr',
]);

export function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '').replace(/:\d+$/, '');
}

export function apexOf(host: string): string {
  const labels = normalizeHost(host).replace(/^\*\./, '').split('.');
  const n = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-n).join('.');
}

/** A plausible public hostname (labels of letters/digits/hyphens, a dot, optional leading `*.`). */
export function isValidHost(raw: string): boolean {
  const h = normalizeHost(raw);
  return h.length <= 253 && /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(h);
}

export type HostKind = 'apex' | 'subdomain' | 'wildcard';

export function hostKind(raw: string): HostKind | null {
  if (!isValidHost(raw)) return null;
  const h = normalizeHost(raw);
  if (h.startsWith('*.')) return 'wildcard';
  return h === apexOf(h) ? 'apex' : 'subdomain';
}

/** `acme.com` ↔ `www.acme.com` (null for wildcards / single labels). */
export function companionOf(raw: string): string | null {
  const h = normalizeHost(raw);
  if (h.startsWith('*.') || !h.includes('.')) return null;
  if (h.startsWith('www.')) return h.slice(4).includes('.') ? h.slice(4) : null;
  return `www.${h}`;
}

/** The live example line under the www choice. */
export function wwwExample(raw: string, mode: WwwMode | 'none'): string {
  const h = normalizeHost(raw);
  const other = companionOf(h);
  if (!other) return `only ${h}`;
  const apex = h.startsWith('www.') ? other : h;
  const www = h.startsWith('www.') ? h : other;
  switch (mode) {
    case 'none':
      return `only ${h} · ${other} won’t answer`;
    case 'redirect-www-to-apex':
      return `${www} → 308 → https://${apex}`;
    case 'redirect-apex-to-www':
      return `${apex} → 308 → https://${www}`;
    case 'serve-both':
      return `${apex} and ${www} both serve the site`;
  }
}

export const WWW_CHOICES: Array<{ value: WwwMode | 'none'; label: string }> = [
  { value: 'none', label: 'none' },
  { value: 'redirect-www-to-apex', label: 'www → apex' },
  { value: 'redirect-apex-to-www', label: 'apex → www' },
  { value: 'serve-both', label: 'serve both' },
];
