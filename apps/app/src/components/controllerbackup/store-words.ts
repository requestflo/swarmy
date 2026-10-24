import type { Tone } from '@/components/calm/tone';

/** The fields of `controllerStore.status` the Summary line reads. */
export interface StoreWordsInput {
  role: string;
  mode: 'replicated' | 'local-only';
  replicating: boolean;
  lagSeconds: number | null;
  problem: string | null;
  hostname: string;
}

/**
 * swarmy's own store in plain words, for the Summary line on Backups. The
 * exact line ("controller store: replicated (lag 3s)") is the Tech line under it.
 */
export function storeWords(s: StoreWordsInput): { tone: Tone; say: string } {
  if (s.role === 'fenced') return { tone: 'bad', say: 'This copy of swarmy lost its turn and is stopping' };
  if (s.mode === 'local-only') return { tone: 'warn', say: `Kept on ${s.hostname} only, so losing that server loses recent changes` };
  if (!s.replicating) return { tone: 'warn', say: 'Set to copy live, but not copying yet' };
  if (s.lagSeconds == null) return { tone: 'warn', say: 'Copied live; how far behind is not known right now' };
  const behind = s.lagSeconds <= 1 ? 'under a second behind' : `${s.lagSeconds} seconds behind`;
  return { tone: s.problem ? 'warn' : 'ok', say: `Copied live off this server, ${behind}` };
}
