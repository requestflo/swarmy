/**
 * Pure: the words on a part's sign chip (board AppCanvas). The label is what
 * shows on the card; the reason is the plain sentence behind it (hover/tap);
 * the tech line is the cosign fact, shown at Controls. "Not checked" says why
 * and never guesses.
 */
import { splitImageRef, type ImageSignatureView } from '@swarmy/core';
import type { Tone } from '@/components/calm';

export interface SignChipWords {
  label: string;
  tone: Tone;
  reason: string;
  tech: string;
}

/** "just now" · "5 minutes ago" · "2 hours ago" · "3 days ago". */
export function agoWords(iso: string | undefined, now: number): string {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return 'at some point';
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (m < 1) return 'just now';
  if (m < 60) return say(m, 'minute');
  if (m < 48 * 60) return say(Math.floor(m / 60), 'hour');
  return say(Math.floor(m / 1440), 'day');
}

function shortDigest(d: string | null): string {
  return d ? `${d.slice(0, 13)}…${d.slice(-4)}` : 'no digest';
}

function checkedWhen(v: ImageSignatureView, now: number): string {
  const when = agoWords(v.checkedAt, now);
  return v.source === 'build' ? `swarmy’s build signed it ${when}` : `checked when it was deployed, ${when}`;
}

export function signChipWords(v: ImageSignatureView, now: number): SignChipWords {
  const digest = shortDigest(v.digest);
  const via = v.source === 'build' ? 'signed at build' : 'verified at deploy';
  switch (v.state) {
    case 'swarmy':
      return {
        label: 'signed',
        tone: 'ok',
        reason: `Signed with your workspace’s own key, the one swarmy signs every build with; ${checkedWhen(v, now)}.`,
        tech: `cosign · ${digest} · workspace key · ${via}`,
      };
    case 'trusted':
      return {
        label: 'signed · trusted key',
        tone: 'ok',
        reason: `Signed with “${v.keyName ?? 'a trusted key'}”, a key you trust; ${checkedWhen(v, now)}.`,
        tech: `cosign · ${digest} · trusted key${v.keyName ? ` ${v.keyName}` : ''} · ${via}`,
      };
    case 'unsigned':
      return {
        label: 'unsigned',
        tone: 'warn',
        reason: `No valid signature from your key or any key you trust; ${checkedWhen(v, now)}.`,
        tech: `cosign verify failed · ${digest} · ${via}`,
      };
    default:
      return unchecked(v);
  }
}

function unchecked(v: ImageSignatureView): SignChipWords {
  const base = { label: 'not checked', tone: 'idle' as const };
  if (v.why === 'third-party') {
    const { host } = splitImageRef(v.image);
    return {
      ...base,
      reason: `Not checked: this image comes from ${host}, and swarmy checks signatures only on images in your own registry.`,
      tech: `${host} · outside the org registry · not verified`,
    };
  }
  if (v.why === 'not-pinned') {
    const { reference } = splitImageRef(v.image);
    return {
      ...base,
      reason: `Not checked: this part runs the tag “${reference}”, not a fixed image, so there is nothing exact to check.`,
      tech: `${v.image} · no @sha256 digest`,
    };
  }
  return {
    ...base,
    reason: 'Not checked yet. swarmy checks a signature when it deploys with signed images required, and records one when its build signs an image.',
    tech: `${shortDigest(v.digest)} · no signature check on record`,
  };
}
