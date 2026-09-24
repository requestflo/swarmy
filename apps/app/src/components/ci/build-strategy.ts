/** How a build was made, in a few words: "Railpack · node 22.23.2 · 14 steps cached". */
export interface BuildStrategy {
  builder?: string | null;
  detected?: { providers: string[]; packages: Record<string, string>; startCommand?: string } | null;
  cachedSteps?: number | null;
}

export function buildStrategyLabel(b: BuildStrategy): string | null {
  if (!b.builder) return null;
  const parts: string[] = [b.builder === 'railpack' ? 'Railpack' : 'Dockerfile'];
  if (b.builder === 'railpack' && b.detected) {
    const tools = Object.entries(b.detected.packages).map(([k, v]) => `${k} ${v}`);
    parts.push(tools.length ? tools.join(', ') : b.detected.providers.join(', '));
  }
  if (b.cachedSteps) parts.push(`${b.cachedSteps} step${b.cachedSteps === 1 ? '' : 's'} cached`);
  return parts.filter(Boolean).join(' · ');
}
