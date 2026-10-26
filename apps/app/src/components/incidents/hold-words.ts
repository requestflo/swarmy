import { INCIDENT_TAKE_MINUTES } from '@swarmy/core';
import { clockWords } from '@/components/apps/app-board-words';

/** The incident hold's words, pure (the phone glance and the incident room share them). */

/** "Sam" from "Sam Okafor" (an address stays whole). */
export function firstName(name: string): string {
  return name.includes('@') ? name : (name.split(/\s+/)[0] ?? name);
}

/** The hold as a sentence: "Sam has this until 14:32." / "You have this until 14:32." / null. */
export function holdWords(owner: { name: string; until: string; mine: boolean } | null): string | null {
  if (!owner) return null;
  return `${owner.mine ? 'You have' : `${firstName(owner.name)} has`} this until ${clockWords(owner.until)}.`;
}

/** The take button's words. */
export const TAKE_LABEL = `Take it for ${INCIDENT_TAKE_MINUTES} min`;
export const KEEP_LABEL = `${INCIDENT_TAKE_MINUTES} more min`;
