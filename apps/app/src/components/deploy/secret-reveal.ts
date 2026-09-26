/**
 * Pure: one one-time reveal line as a banner row. Reveals are the templates'
 * own `reveal` lines ("Grafana admin login: admin / s3cret (shown once, so
 * save it now)") and the Directus login ("… — email / s3cret (…)"): a label,
 * then an optional login and the secret. Anything else is one secret, whole.
 */
export interface RevealRow {
  label: string;
  /** The login shown in the clear ("admin", an email), when there is one. */
  login: string | null;
  /** The value to mask and copy. */
  secret: string;
}

export function revealRow(note: string): RevealRow {
  const text = note.replace(/\s*\(shown once[^)]*\)\s*$/i, '').trim();
  const cut = text.match(/^(.+?)(?::\s| — )(.+)$/);
  if (!cut) return { label: 'Secret', login: null, secret: text };
  const [, label, value] = cut as unknown as [string, string, string];
  const slash = value.lastIndexOf(' / ');
  return slash === -1
    ? { label: label.trim(), login: null, secret: value.trim() }
    : { label: label.trim(), login: value.slice(0, slash).trim(), secret: value.slice(slash + 3).trim() };
}
