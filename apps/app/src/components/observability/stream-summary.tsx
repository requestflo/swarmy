import * as React from 'react';
import { Say } from '@/components/calm';
import type { LevelCounts } from './stream-model';

const n = (x: number): string => x.toLocaleString('en-GB');
const plural = (x: number, one: string, many = `${one}s`): string => `${n(x)} ${x === 1 ? one : many}`;

function listWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The Logs & traces sentence, from the lines actually on screen: how many
 * errors in the window and where they came from, or that it's quiet.
 */
export function streamHeadline(
  stack: string,
  counts: LevelCounts,
  errorParts: string[],
  rangeWords: string,
  capped: boolean,
): { title: React.ReactNode; lede: string } {
  const scope = capped ? `in the newest ${n(counts.all)} lines` : `in the last ${rangeWords}`;
  const lede = `${plural(counts.all, 'line')} ${scope}: ${plural(counts.error, 'error')}, ${plural(counts.warn, 'warning')}, ${n(counts.info)} info and ${n(counts.debug)} debug. Newest at the bottom.`;
  if (counts.all === 0) {
    return { title: <>{stack} has been quiet. <em>No lines {scope}.</em></>, lede: 'New lines appear here as they arrive.' };
  }
  if (counts.error === 0) {
    return { title: <>{stack} logged no errors {scope}.</>, lede };
  }
  const where = errorParts.length === 1 ? `all from ${errorParts[0]}` : `from ${listWords(errorParts.slice(0, 3))}`;
  return {
    title: (
      <>
        {stack} <Say tone="bad">logged {plural(counts.error, 'error')}</Say> {scope}, {where}.
      </>
    ),
    lede,
  };
}
