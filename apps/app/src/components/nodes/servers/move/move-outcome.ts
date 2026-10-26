import { MOVE_UNDO_WINDOW_HOURS, OLD_COPY_KEEP_DAYS, type MoveStep } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { MovePhase } from './move-rules';

/**
 * The move card's headline (board 9) for a move and for its Undo, pure. A
 * move copies and checks the data; an Undo copies nothing — it goes back
 * onto the old copy, once both copies match the move's snapshot point.
 */

export interface Outcome {
  tone: Tone;
  word: string;
  title: string;
  body: string;
}

export function outcomeWords(o: { phase: MovePhase; short: string; from: string; to: string; undo: boolean }): Outcome {
  const { short: s, from, to } = o;
  if (o.undo) {
    switch (o.phase) {
      case 'done':
        return { tone: 'ok', word: 'Put back', title: `${s} is back on ${to}.`, body: `Nothing was copied: it runs on the copy it left there, which hadn’t changed. The copy on ${from} is kept as the old copy now.` };
      case 'rolled-back':
        return { tone: 'warn', word: 'Stayed', title: `${s} stays on ${from}.`, body: `Something changed while swarmy paused it, so it started it again where it was. Nothing was lost.` };
      case 'not-started':
        return { tone: 'bad', word: 'Didn’t start', title: `The undo of ${s} didn’t start.`, body: 'Nothing changed.' };
      default:
        return { tone: 'info', word: 'Putting back', title: `Putting ${s} back on ${to}`, body: `A short pause on ${from} to check nothing wrote to it since the move.` };
    }
  }
  switch (o.phase) {
    case 'done':
      return {
        tone: 'ok',
        word: 'Moved',
        title: `${s} now runs on ${to}.`,
        body: `The old copy stays on ${from}: Undo can use it for ${MOVE_UNDO_WINDOW_HOURS} hours, and ${from}’s page asks about it after ${OLD_COPY_KEEP_DAYS} days.`,
      };
    case 'rolled-back':
      return { tone: 'warn', word: 'Put back', title: `${s} is back on ${from}.`, body: 'Something went wrong mid-move, so swarmy put it back where its data is. Any copy it had started is removed.' };
    case 'not-started':
      return { tone: 'bad', word: 'Didn’t start', title: `The move of ${s} didn’t start.`, body: 'swarmy refused it before copying anything, so nothing changed.' };
    default:
      return { tone: 'info', word: 'Moving', title: `Moving ${s} to ${to}`, body: `It keeps running on ${from} until the last, short pause.` };
  }
}

/** The steps an Undo takes (it copies nothing, so there is no serve or copy pass). */
export const UNDO_STEP_ORDER: MoveStep[] = ['stop', 'verify', 'repin', 'start'];

export const UNDO_STEP_WORDS: Partial<Record<MoveStep, string>> = {
  stop: 'Pausing it on the new server',
  verify: 'Checking nothing wrote to it since the move',
  repin: 'Pointing it back at the old copy',
  start: 'Starting it on the old server',
};

/** The sentence beside Undo, before it is pressed. */
export function undoOffer(short: string, from: string): string {
  return `Undo puts ${short} back on ${from}, on the copy it left there, if nothing has written to either copy since.`;
}
