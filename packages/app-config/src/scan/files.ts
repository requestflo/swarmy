/**
 * The scan's inputs and the line readers every detector shares. Everything is
 * line-based so it works the same on a whole file (local disk), a 4 KB probe
 * (git.inspect) and grep hits (only the matching lines, real line numbers).
 */
import type { Evidence, ScanFile, ScanLine } from './types';

/** The compose files a scan reads, in the order compose itself prefers. */
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const;

/** Manifests the detectors read in the app's folder (git.inspect probes them, 4 KB each). */
export const SCAN_FILES = [
  'Dockerfile',
  'package.json',
  'Procfile',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'Gemfile',
  'go.mod',
  'composer.json',
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  'vercel.json',
  'app.json',
  'prisma/schema.prisma',
  'drizzle.config.ts',
  'drizzle.config.js',
  ...COMPOSE_FILES,
  // Rails: the database adapter, Active Storage's service, whenever's schedule.
  'config/database.yml',
  'config/storage.yml',
  'config/schedule.rb',
] as const;
/** Files whose presence alone says something (migration tools, lockfiles). */
export const SCAN_PRESENCE_FILES = ['manage.py', 'alembic.ini', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'] as const;

/**
 * Source lines worth a look (POSIX ERE — git.inspect greps with it; JS reads
 * it as a RegExp). Drivers, clients, env reads, schedulers and listen().
 */
export const SOURCE_SCAN_PATTERN =
  'DATABASE_URL|POSTGRES|postgres|PrismaClient|drizzle|psycopg|create_engine|REDIS|Redis\\(|ioredis|createClient|bullmq|new (Queue|Worker)\\(|VALKEY|S3Client|AWS\\.S3|boto3|S3_[A-Z]|_BUCKET|schedule\\(|scheduleJob|CronJob|@Cron|beat_schedule|CELERY_BEAT|listen\\(';
export const SOURCE_SCAN_MAX_FILES = 40;
export const SOURCE_SCAN_MAX_HITS_PER_FILE = 4;
export const SOURCE_SCAN_MAX_HITS = 60;

/** Source files worth grepping, and the ones never worth it (POSIX ERE, shared with git.inspect). */
export const SOURCE_PATH_RE = '\\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|php)$';
export const SOURCE_SKIP_RE =
  '(^|/)(node_modules|vendor|dist|build|out|coverage|\\.next|\\.git|tests?|__tests__|spec|fixtures|migrations)/|\\.(test|spec|d)\\.[a-z]+$|\\.config\\.[a-z]+$';
const SOURCE_PATH = new RegExp(SOURCE_PATH_RE);
const SOURCE_SKIP = new RegExp(SOURCE_SKIP_RE);

/** A source file the scan greps (app code under `dir`, never tests, builds or vendored code). */
export function isSourcePath(p: string, dir = ''): boolean {
  if (dir && !p.startsWith(`${dir}/`)) return false;
  return SOURCE_PATH.test(p) && !SOURCE_SKIP.test(p);
}

export function scanFile(path: string, text: string): ScanFile {
  return { path, lines: text.split(/\r?\n/).map((t, i) => ({ no: i + 1, text: t })) };
}

/** grep hits (`{ line, text }`) as a sparse file. */
export function scanHits(path: string, hits: Array<{ line: number; text: string }>): ScanFile {
  return { path, lines: hits.map((h) => ({ no: h.line, text: h.text })) };
}

export function ev(f: ScanFile, l: ScanLine): Evidence {
  const text = l.text.trim().replace(/\s+/g, ' ');
  return { file: f.path, line: l.no, text: text.length > 160 ? `${text.slice(0, 157)}…` : text };
}

export const at = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

export interface JsonEntry {
  /** Enclosing object keys, outermost first (`['dependencies']`, `['crons']`). */
  path: string[];
  key: string;
  value: string;
  line: ScanLine;
}

const TOKEN = /"(?:[^"\\]|\\.)*"|[{}[\]:,]/g;

/** Every `"key": "value"` in a JSON file with the object it sits in — a lexer, so truncation is harmless. */
export function jsonEntries(f: ScanFile): JsonEntry[] {
  const out: JsonEntry[] = [];
  const stack: Array<string | null> = [];
  let last: string | null = null;
  let key: string | null = null;
  for (const line of f.lines) {
    for (const m of line.text.matchAll(TOKEN)) {
      const t = m[0];
      if (t.startsWith('"')) {
        const s = t.slice(1, -1).replace(/\\(.)/g, '$1');
        if (key !== null) {
          out.push({ path: stack.filter((k): k is string => k !== null), key, value: s, line });
          key = null;
        } else last = s;
      } else if (t === ':') key = last;
      else if (t === '{' || t === '[') {
        stack.push(key);
        key = null;
      } else if (t === '}' || t === ']') stack.pop();
      else key = null;
    }
  }
  return out;
}

export interface KeyValue {
  name: string;
  value: string;
  line: ScanLine;
}

/** `NAME=value` lines of a dotenv file. */
export function envEntries(f: ScanFile): KeyValue[] {
  return f.lines.flatMap((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.text);
    return m ? [{ name: m[1]!, value: m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2'), line }] : [];
  });
}

/** `name: command` lines of a Procfile. */
export function procfileEntries(f: ScanFile): KeyValue[] {
  return f.lines.flatMap((line) => {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line.text);
    return m ? [{ name: m[1]!, value: m[2]!.trim(), line }] : [];
  });
}

/** Lower-kebab unit name (`My_Jobs` → `my-jobs`), or null when nothing usable is left. */
export function unitNameOf(raw: string): string | null {
  const n = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 30)
    .replace(/-+$/, '');
  return n || null;
}
