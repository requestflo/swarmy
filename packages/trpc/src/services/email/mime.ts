/**
 * Minimal MIME — enough to BUILD the messages the send API submits
 * (text + HTML alternative, RFC 2047 subjects, quoted-printable bodies) and to
 * PARSE the reports that come back (multipart/report DSNs and ARF complaints).
 * Pure; no dependencies.
 */
import { randomBytes } from 'node:crypto';

// ── parse ────────────────────────────────────────────────────────────────────

export interface MimeHeaders {
  /** Lowercased name → values in order. */
  all: Map<string, string[]>;
  get(name: string): string | undefined;
}

export interface MimePart {
  headers: MimeHeaders;
  /** `type/subtype`, lowercase (default text/plain). */
  contentType: string;
  params: Record<string, string>;
  /** Decoded body (transfer encoding undone), as a string. */
  body: string;
  /** Child parts of a multipart. */
  parts: MimePart[];
}

/** Parse `Key: value` header lines (unfolding continuation lines). */
export function parseHeaderBlock(block: string): MimeHeaders {
  const all = new Map<string, string[]>();
  let last: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      const vals = all.get(last)!;
      vals[vals.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    const v = line.slice(colon + 1).trim();
    all.set(last, [...(all.get(last) ?? []), v]);
  }
  return { all, get: (n) => all.get(n.toLowerCase())?.[0] };
}

/** `text/plain; charset="utf-8"` → type + params. */
export function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  const [type = 'text/plain', ...rest] = (value ?? 'text/plain').split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { type: type.trim().toLowerCase(), params };
}

function decodeBody(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    const bytes = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
  return body;
}

/** Parse a whole message (or part) recursively. */
export function parseMime(raw: string, depth = 0): MimePart {
  const m = /\r?\n\r?\n/.exec(raw);
  const headBlock = m ? raw.slice(0, m.index) : raw;
  const bodyRaw = m ? raw.slice(m.index + m[0].length) : '';
  const headers = parseHeaderBlock(headBlock);
  const { type, params } = parseContentType(headers.get('content-type'));
  const parts: MimePart[] = [];
  if (type.startsWith('multipart/') && params.boundary && depth < 8) {
    const b = params.boundary;
    const pieces = bodyRaw.split(new RegExp(`\\r?\\n?--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \\t]*\\r?\\n?`));
    // pieces[0] = preamble; then part, undefined(--), part, …, epilogue
    for (let i = 1; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece === undefined || piece === '--') continue;
      if (i === pieces.length - 1 && !/\S/.test(piece)) continue;
      parts.push(parseMime(piece, depth + 1));
    }
    return { headers, contentType: type, params, body: '', parts };
  }
  return { headers, contentType: type, params, body: decodeBody(bodyRaw, headers.get('content-transfer-encoding')), parts };
}

/** Depth-first search for the first part of a type. */
export function findPart(part: MimePart, type: string): MimePart | undefined {
  if (part.contentType === type) return part;
  for (const p of part.parts) {
    const hit = findPart(p, type);
    if (hit) return hit;
  }
  return undefined;
}

/** Decode RFC 2047 encoded-words in a header value. */
export function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _cs: string, enc: string, text: string) => {
    if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf8');
    const bytes = text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  });
}

// ── build ────────────────────────────────────────────────────────────────────

/** RFC 2047 B-encode a header value when it is not plain ASCII. */
export function encodeWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Quoted-printable (RFC 2045), lines ≤ 76. */
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r?\n/g, '\n').split('\n');
  return lines
    .map((line) => {
      let enc = '';
      for (const byte of Buffer.from(line, 'utf8')) {
        const ch = String.fromCharCode(byte);
        enc += (byte >= 33 && byte <= 126 && ch !== '=') || byte === 32 ? ch : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
      enc = enc.replace(/ $/, '=20');
      const out: string[] = [];
      while (enc.length > 75) {
        let cut = 75;
        // never split an =XX escape
        const esc = enc.lastIndexOf('=', cut);
        if (esc > cut - 3) cut = esc;
        out.push(`${enc.slice(0, cut)}=`);
        enc = enc.slice(cut);
      }
      out.push(enc);
      return out.join('\r\n');
    })
    .join('\r\n');
}

export interface BuildMessageInput {
  from: string;
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  /** Extra headers (e.g. List-Unsubscribe). Names are validated. */
  headers?: Record<string, string>;
  /** Domain for the Message-ID (the sending domain). */
  messageIdDomain: string;
  date?: Date;
}

export interface BuiltMessage {
  raw: string;
  messageId: string;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding', 'dkim-signature']);

/** Strip CR/LF so a caller value can never inject a header. */
function oneLine(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim();
}

export function buildMessage(input: BuildMessageInput): BuiltMessage {
  const messageId = `<${randomBytes(12).toString('hex')}@${input.messageIdDomain}>`;
  const head: string[] = [
    `From: ${oneLine(input.from)}`,
    `To: ${input.to.map(oneLine).join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.map(oneLine).join(', ')}`] : []),
    ...(input.replyTo ? [`Reply-To: ${oneLine(input.replyTo)}`] : []),
    `Subject: ${encodeWord(oneLine(input.subject))}`,
    `Date: ${(input.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (!HEADER_NAME.test(k) || RESERVED_HEADERS.has(k.toLowerCase())) continue;
    head.push(`${k}: ${oneLine(v)}`);
  }
  const text = input.text ?? (input.html ? htmlToText(input.html) : '');
  const leaf = (type: string, body: string) =>
    `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(body)}`;
  let body: string;
  if (input.html) {
    const boundary = `swarmy-${randomBytes(9).toString('hex')}`;
    head.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [`--${boundary}`, leaf('text/plain', text), `--${boundary}`, leaf('text/html', input.html), `--${boundary}--`, ''].join('\r\n');
    return { raw: `${head.join('\r\n')}\r\n\r\n${body}`, messageId };
  }
  head.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable');
  return { raw: `${head.join('\r\n')}\r\n\r\n${quotedPrintable(text)}\r\n`, messageId };
}

/** A readable plain-text fallback from HTML (for the text/plain alternative). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── templates ────────────────────────────────────────────────────────────────

const VAR = /\{\{\{?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}?\}\}/g;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Render `{{ name }}` placeholders. In HTML, values are escaped unless written
 * `{{{ name }}}`. Returns the variables that had no value (rendered empty).
 */
export function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
  mode: 'html' | 'text',
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = template.replace(VAR, (whole, path: string) => {
    const raw = lookup(vars, path);
    if (raw === undefined || raw === null) {
      missing.push(path);
      return '';
    }
    const s = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : JSON.stringify(raw);
    return mode === 'html' && !whole.startsWith('{{{') ? escapeHtml(s) : s;
  });
  return { value, missing: [...new Set(missing)] };
}
