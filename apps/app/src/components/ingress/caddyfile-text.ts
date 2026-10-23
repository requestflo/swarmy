/**
 * Read-only helpers over the Caddyfile `ingress.previewConfig` renders — the
 * exact text swarmy writes to the edge. Pure string work, no parsing beyond
 * the renderer's own shape: top-level site blocks open with `<address> {` at
 * column 0 and close with `}` at column 0 (packages/ingress/src/render/caddyfile.ts).
 */

export interface PreviewLike {
  files: { path: string; contents: string }[];
  localReload?: { service: string; file?: { path: string; contents: string } } | undefined;
}

/** The Caddyfile in a render: the in-task file (swarmy-run Caddy) or a written file. */
export function caddyfileOf(p: PreviewLike | undefined): string | null {
  if (!p) return null;
  const inTask = p.localReload?.file;
  if (inTask && /caddyfile$/i.test(inTask.path)) return inTask.contents;
  return p.files.find((f) => /caddyfile$/i.test(f.path))?.contents ?? null;
}

/** Hosts named on a site block's opening line (`a.com, www.a.com {`, `http://a.com {`). */
function addresses(line: string): string[] {
  return line
    .replace(/\{\s*$/, '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((a) => a.replace(/^https?:\/\//, '').replace(/:\d+$/, '').toLowerCase());
}

/** Every top-level block's text, keyed by its opening line. */
function blocks(text: string): Array<{ head: string; body: string }> {
  const out: Array<{ head: string; body: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!;
    if (!/^(\{|\S.*\{)\s*$/.test(head)) continue;
    const end = lines.findIndex((l, k) => k > i && l === '}');
    if (end < 0) break;
    out.push({ head, body: lines.slice(i, end + 1).join('\n') });
    i = end;
  }
  return out;
}

/** The site block(s) that serve `host` — what the edge does with a visit to it. */
export function siteBlock(text: string, host: string): string | null {
  const h = host.toLowerCase();
  const found = blocks(text).filter((b) => b.head !== '{' && addresses(b.head).includes(h));
  return found.length ? found.map((b) => b.body).join('\n\n') : null;
}

/** On-demand TLS as rendered: `on_demand_tls { ask <url> }` in the global options. */
export function onDemandOf(text: string | null): { on: boolean; ask: string | null } {
  const global = text ? blocks(text).find((b) => b.head === '{')?.body : undefined;
  const m = global?.match(/on_demand_tls\s*\{([^}]*)\}/);
  if (!m) return { on: false, ask: null };
  return { on: true, ask: m[1]!.match(/ask\s+(\S+)/)?.[1] ?? null };
}
