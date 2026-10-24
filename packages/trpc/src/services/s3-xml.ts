/**
 * Just enough XML for S3 bucket-configuration documents (CORS, lifecycle) —
 * flat, element-only, no namespaces beyond the root's `xmlns`, exactly what
 * Garage's quick-xml serializer emits. No dependency, no DOM. Pure.
 */

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** `<Tag>escaped</Tag>`. */
export function el(tag: string, value: string | number): string {
  return `<${tag}>${xmlEscape(String(value))}</${tag}>`;
}

/**
 * Inner text of every `<tag>…</tag>` (and `<tag/>` as ''), in document order.
 * The tag name must be followed by `>`, `/` or whitespace, so `<Days>` never
 * matches `<DaysAfterInitiation>`. Same-name nesting is not supported (S3
 * config documents have none).
 */
export function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1] ?? '');
  return out;
}

/** The first `<tag>` inner text, or null when absent. */
export function xmlOne(xml: string, tag: string): string | null {
  return xmlAll(xml, tag)[0] ?? null;
}

/** Leaf text values (unescaped, trimmed) of every `<tag>`. */
export function xmlTexts(xml: string, tag: string): string[] {
  return xmlAll(xml, tag).map((v) => xmlUnescape(v.trim()));
}

/** A leaf's integer value, or null when absent / not a number. */
export function xmlInt(xml: string, tag: string): number | null {
  const v = xmlOne(xml, tag);
  if (v === null) return null;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** The S3 error `<Message>` (or `<Code>`) of an error body, for a readable refusal. */
export function s3ErrorText(body: string): string {
  const message = xmlOne(body, 'Message');
  const code = xmlOne(body, 'Code');
  return xmlUnescape((message ?? code ?? body).trim()).slice(0, 300);
}
