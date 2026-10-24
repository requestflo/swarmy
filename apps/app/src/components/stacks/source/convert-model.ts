import type { ComposeGap, ConfigIssue } from '@swarmy/app-config';
import type { Tone } from '@/components/calm';

/**
 * Convert to swarmy.yaml, the pure parts: the parser's verdict as a chip,
 * the "didn't translate" order, and a reason as a sentence.
 */
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "valid · v1" / "valid · v1 · 1 warning" / "2 problems · line 14" — the controller parser's word. */
export function convertStatus(issues: readonly Pick<ConfigIssue, 'severity' | 'line'>[]): { tone: Tone; text: string } {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    const line = errors.find((i) => i.line)?.line;
    return { tone: 'bad', text: `${plural(errors.length, 'problem')}${line ? ` · line ${line}` : ''}` };
  }
  return issues.length ? { tone: 'warn', text: `valid · v1 · ${plural(issues.length, 'warning')}` } : { tone: 'ok', text: 'valid · v1' };
}

/** What to look at first, then what swarmy covers itself (nothing lost there); stable otherwise. */
export function sortGaps(gaps: readonly ComposeGap[]): ComposeGap[] {
  return [...gaps].sort((a, b) => Number(Boolean(a.handled)) - Number(Boolean(b.handled)));
}

/** A reason as a sentence: capitalised (never the brand, which stays lowercase) and full-stopped. */
export function sentence(s: string): string {
  const head = s.startsWith('swarmy') ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  return /[.!?]$/.test(head) ? head : `${head}.`;
}
