import { cellText } from './studio-types';

/** RFC 4180 CSV of a result grid (NULL → empty field, objects → JSON). */
export function toCsv(columns: string[], rows: unknown[][]): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const line = (r: unknown[]) => r.map((v) => (v === null || v === undefined ? '' : q(cellText(v)))).join(',');
  return [columns.map(q).join(','), ...rows.map(line)].join('\r\n') + '\r\n';
}

/** JSON: Mongo documents as-is, SQL/Redis rows as objects keyed by column. */
export function toJson(columns: string[], rows: unknown[][], documents?: unknown[]): string {
  const data = documents ?? rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
  return JSON.stringify(data, null, 2);
}

export function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
