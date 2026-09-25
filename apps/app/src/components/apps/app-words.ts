import type { InvService } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { StackStat } from '@/components/canvas/stack-aggregates';

/**
 * Plain words for an app (a Docker stack), built from its live inventory
 * aggregate. Summary depth reads `say` and `word`; `tech` is the Controls line
 * (services, replicas, image) where the technical words are allowed.
 */
export interface AppWords {
  tone: Tone;
  /** The status word: Online · Deploying · Needs you · Offline · Idle. */
  word: string;
  /** One plain sentence (no glossary words). */
  say: string;
  /** Controls-depth line: `4 services · 10/11 replicas · web:1.8.2`. */
  tech: string;
  /** Needs a person: degraded or down. */
  attention: boolean;
}

/** Map the inventory status token (online · warning · progress · offline · idle) to a Calm tone. */
export function stackTone(token: string): Tone {
  if (token === 'online') return 'ok';
  if (token === 'warning') return 'warn';
  if (token === 'offline') return 'bad';
  if (token === 'progress') return 'info';
  return 'idle';
}

/** `ghcr.io/northwind/web:1.8.2@sha256:…` → `web:1.8.2`. */
export function shortImage(image: string): string {
  const noDigest = image.split('@')[0] ?? image;
  return noDigest.split('/').pop() ?? noDigest;
}

/** `ghcr.io/northwind/web:1.8.2` → `1.8.2` (null when untagged). */
export function imageTag(image: string): string | null {
  const last = shortImage(image);
  const i = last.lastIndexOf(':');
  return i > 0 ? last.slice(i + 1) : null;
}

/** `calum@gomacrae.com` → `Calum`; null → `Someone`. */
export function personName(actor: string | null | undefined): string {
  if (!actor) return 'Someone';
  const base = actor.includes('@') ? actor.split('@')[0]! : actor;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** 3 → "Three" (sentence-leading numbers read as words up to ten). */
export function numberWord(n: number, lower = false): string {
  const w = WORDS[n] ?? String(n);
  return lower && n <= 10 ? w.toLowerCase() : w;
}

function worst(services: InvService[], statuses: InvService['status'][]): InvService | undefined {
  return services.find((s) => statuses.includes(s.status));
}

export function appWords(stat: StackStat): AppWords {
  const tone = stackTone(stat.tone);
  const n = stat.serviceCount;
  const lead = stat.services[0];
  const tech = [
    plural(n, 'service'),
    `×${stat.running}/${stat.desired}`,
    lead ? shortImage(lead.image) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (tone === 'bad') {
    const s = worst(stat.services, ['failing']);
    return { tone, word: 'Offline', tech, attention: true, say: s ? `${s.name} keeps failing to start.` : 'It is down.' };
  }
  if (tone === 'warn') {
    const s = worst(stat.services, ['degraded']);
    const say = s
      ? `${s.name} is running ${s.replicas.running} of ${s.replicas.desired} copies.`
      : `${stat.running} of ${stat.desired} copies are running.`;
    return { tone, word: 'Needs you', tech, attention: true, say };
  }
  if (tone === 'info') {
    const up = stat.services.filter((s) => s.status === 'running').length;
    return { tone, word: 'Deploying', tech, attention: false, say: `Deploying. ${up} of ${n} parts are up.` };
  }
  if (tone === 'idle') {
    const asleep = stat.services.some((s) => s.scaleToZero);
    return {
      tone,
      word: 'Idle',
      tech,
      attention: false,
      say: asleep ? 'Asleep until someone visits.' : 'Stopped on purpose.',
    };
  }
  return {
    tone,
    word: 'Online',
    tech,
    attention: false,
    say: n === 1 ? 'Online. Its one part is running.' : `Online. All ${n} parts are running.`,
  };
}
