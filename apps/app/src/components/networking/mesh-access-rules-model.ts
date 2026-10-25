/** Pure helpers for Mesh settings' access rules (mesh-access-rules-section.tsx). */

/** "5432, 6379" → [5432, 6379]; empty = every port; anything else is the reason it isn't a port list. */
export function parsePorts(text: string): number[] | string {
  const parts = text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return `${p} isn't a port: use numbers like 5432, 6379`;
    const n = Number(p);
    if (n < 1 || n > 65535) return `${p} isn't a port (1 to 65535)`;
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > 16) return 'at most 16 ports in one rule';
  return out;
}

const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`;

/** The section's count: "3 rules · 1 kept by swarmy". */
export function rulesCount(rules: { managedBySwarmy: boolean }[]): string {
  const own = rules.filter((r) => r.managedBySwarmy).length;
  return own ? `${plural(rules.length, 'rule')} · ${own} kept by swarmy` : plural(rules.length, 'rule');
}
