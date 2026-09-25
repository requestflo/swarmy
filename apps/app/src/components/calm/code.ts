/**
 * Builders for the Code depth, so every page's code view speaks the same
 * dialect. Honesty rules (plans/redesign-build.md §1):
 *   - REST paths must exist in packages/api-rest/openapi.json (mounted at /api/v1).
 *   - CLI lines use only real `swarmy` commands (apps/cli/src/main.ts):
 *     login · logout · whoami · link · unlink · check · deploy · logs ·
 *     env ls|pull|push · run · open · status · mcp · explain ·
 *     sourcemaps upload · errors dsn|rotate-key.
 *   - swarmy.yaml keys follow packages/app-config.
 * When a thing has none of those, show what swarmy sees (rendered labels,
 * the live spec) with `source="readonly"`, never an invented command.
 */

export const API_BASE = 'https://swarmy.example.com/api/v1';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json | undefined };

/** A curl call against the public REST API. */
export function curl(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: Json): string {
  const lines = [`curl -X ${method} ${API_BASE}${path} \\`, `  -H "Authorization: Bearer $SWARMY_TOKEN"`];
  if (body !== undefined) {
    lines[1] += ' \\';
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '${JSON.stringify(body)}'`);
  }
  return lines.join('\n');
}

/** A REST exchange: the request line and the JSON the dashboard is showing. */
export function restExchange(method: string, path: string, response: Json): string {
  return `${method} /api/v1${path}\nAuthorization: Bearer $SWARMY_TOKEN\n\n${JSON.stringify(response, null, 2)}`;
}

function scalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v !== 'string') return String(v);
  if (v === '' || /^[\s]|[\s]$|[:#{}[\],&*!|>'"%@`]|^(true|false|null|yes|no|~|-?\d[\d.]*)$/i.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

/** A small YAML emitter (objects, arrays, scalars) for swarmy.yaml / compose snippets. */
export function toYaml(value: Json, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const inner = toYaml(item, indent + 1).trimStart();
          return `${pad}- ${inner}`;
        }
        return `${pad}- ${scalar(item)}`;
      })
      .join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined) as [string, Json][];
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, v]) => {
        if (v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${v !== null && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}`;
      })
      .join('\n');
  }
  return `${pad}${scalar(value)}`;
}

/** `# comment` header + body, the house style for code panels. */
export function withHeader(comment: string, body: string): string {
  return `# ${comment}\n${body}`;
}
