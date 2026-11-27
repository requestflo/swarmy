/**
 * Requirement and decision records (DR-001): parse, check and index.
 *
 *   bun run scripts/records.ts check   # validate every record; CI runs this
 *   bun run scripts/records.ts index   # regenerate docs/RECORDS.md
 *
 * Records live in docs/requirements/*.md (BR-NNN, NFR-NNN; several per file, one `##`
 * heading each) and docs/decisions/NNN-*.md (DR-NNN; MADR 4.0, one per file). The rules
 * the check enforces are in docs/decisions/README.md. Everything above `main` is pure so
 * records.test.ts can drive it with inline fixtures.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

export const STATUSES = ['Proposed', 'Accepted', 'Rejected', 'Superseded', 'Deprecated'] as const;
export type Status = (typeof STATUSES)[number];
export type Kind = 'BR' | 'NFR' | 'DR';

export interface RecordEntry {
  id: string;
  kind: Kind;
  title: string;
  status: Status;
  /** Repo-relative path of the file that holds it. */
  file: string;
  /** Field values keyed in lower case (`status`, `revision`, `verified by`, `supersedes` …). */
  fields: Record<string, string>;
  body: string;
}

export interface Problem {
  file: string;
  message: string;
}

export interface SourceFile {
  /** Repo-relative path. */
  path: string;
  text: string;
}

/** Instruction files that agents load on every session stay short enough to read whole. */
export const INSTRUCTION_LINE_LIMIT = 200;

const ID_RE = /\b(BR|NFR|DR)-(\d{3})\b/g;
const REQ_HEADING = /^## ((BR|NFR)-\d{3})(?: · (.+?))?\s*$/;
const FIELD = /^- ([A-Z][A-Za-z -]*): (.+)$/;

/** CRLF checkouts parse the same as LF ones. */
function lf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function toStatus(raw: string | undefined): Status | undefined {
  if (!raw) return undefined;
  const word = raw.trim().split(/\s+/)[0] ?? '';
  const cap = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  return (STATUSES as readonly string[]).includes(cap) ? (cap as Status) : undefined;
}

function idList(raw: string | undefined): string[] {
  return raw ? [...raw.matchAll(ID_RE)].map((m) => m[0]) : [];
}

/** Parse a requirements file: each `## BR-NNN · Title` heading, its `- Field: value` list, then its text. */
export function parseRequirements(
  file: string,
  text: string,
): { records: RecordEntry[]; problems: Problem[] } {
  const records: RecordEntry[] = [];
  const problems: Problem[] = [];
  const expected: Kind = /(^|\/)nfr-[^/]+\.md$/.test(file) ? 'NFR' : 'BR';
  const sections = lf(text)
    .split(/^(?=## )/m)
    .filter((s) => s.startsWith('## '));
  for (const section of sections) {
    const lines = section.trimEnd().split('\n');
    const head = REQ_HEADING.exec(lines[0] ?? '');
    if (!head) {
      problems.push({ file, message: `"${lines[0]}" is not a record heading (## BR-NNN · Title)` });
      continue;
    }
    const id = head[1]!;
    const kind = head[2] as Kind;
    if (kind !== expected)
      problems.push({ file, message: `${id} belongs in a ${kind.toLowerCase()}-*.md file` });
    const fields: Record<string, string> = {};
    let i = 1;
    while (i < lines.length && (lines[i]!.trim() === '' || FIELD.test(lines[i]!))) {
      const f = FIELD.exec(lines[i]!);
      if (f) {
        const key = f[1]!.toLowerCase();
        if (key in fields) problems.push({ file, message: `${id} repeats the ${f[1]} field` });
        fields[key] = f[2]!.trim();
      }
      i += 1;
    }
    const body = lines.slice(i).join('\n').trim();
    const status = toStatus(fields.status);
    if (!fields.status) problems.push({ file, message: `${id} has no Status field` });
    else if (!status)
      problems.push({ file, message: `${id} has an unknown status "${fields.status}"` });
    if (!/^[1-9]\d*$/.test(fields.revision ?? '')) {
      problems.push({
        file,
        message: `${id} needs a Revision field holding a whole number from 1`,
      });
    }
    if (kind === 'BR' && !body) problems.push({ file, message: `${id} has no requirement text` });
    if (kind === 'NFR' && !fields.target)
      problems.push({ file, message: `${id} has no Target field` });
    if (status) {
      records.push({ id, kind, title: head[3]?.trim() ?? '', status, file, fields, body });
    }
  }
  return { records, problems };
}

/** Parse one MADR decision file: front matter (id, status, date, decision-makers) and `# DR-NNN: Title`. */
export function parseDecision(
  file: string,
  text: string,
): { record?: RecordEntry; problems: Problem[] } {
  const problems: Problem[] = [];
  const src = lf(text);
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!fm) return { problems: [{ file, message: 'has no front matter between --- lines' }] };
  const fields: Record<string, string> = {};
  for (const line of fm[1]!.split('\n')) {
    const kv = /^([a-z][a-z-]*):\s*(.*?)\s*(#.*)?$/.exec(line);
    // YAML reads `status: "accepted"` the same as `status: accepted`.
    if (kv) fields[kv[1]!] = kv[2]!.replace(/^(["'])(.*)\1$/, '$2');
  }
  for (const key of ['id', 'status', 'date', 'decision-makers']) {
    if (!fields[key]) problems.push({ file, message: `front matter has no ${key}` });
  }
  const id = fields.id ?? '';
  if (id && !/^DR-\d{3}$/.test(id)) problems.push({ file, message: `id "${id}" is not DR-NNN` });
  const status = toStatus(fields.status);
  if (fields.status && !status)
    problems.push({ file, message: `unknown status "${fields.status}"` });
  if (fields.date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) {
    problems.push({ file, message: `date "${fields.date}" is not YYYY-MM-DD` });
  }
  const name = file.split('/').pop() ?? '';
  if (id && !name.startsWith(`${id.slice(3)}-`)) {
    problems.push({ file, message: `file name must start with ${id.slice(3)}- to match ${id}` });
  }
  const rest = src.slice(fm[0].length);
  const h1 = /^# (DR-\d{3}): (.+)$/m.exec(rest);
  if (!h1) problems.push({ file, message: 'has no "# DR-NNN: Title" heading' });
  else if (id && h1[1] !== id)
    problems.push({ file, message: `heading says ${h1[1]} but front matter says ${id}` });
  if (problems.length > 0 || !status || !h1) return { problems };
  return {
    record: { id, kind: 'DR', title: h1[2]!.trim(), status, file, fields, body: rest.trim() },
    problems,
  };
}

/** IDs cited in prose. Fenced code and inline code are skipped: they hold examples, not citations. */
export function citedIds(text: string): string[] {
  const prose = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '');
  return [...new Set([...prose.matchAll(ID_RE)].map((m) => m[0]))];
}

function linkFields(r: RecordEntry): { supersedes: string[]; supersededBy: string[] } {
  return {
    supersedes: idList(r.fields.supersedes),
    supersededBy: idList(r.fields['superseded-by'] ?? r.fields['superseded by']),
  };
}

/**
 * Cross-record rules: unique IDs, two-sided supersede links, cited IDs exist, the index is
 * current, instruction files stay short. Accepted BRs and NFRs with no `Verified by` are
 * warnings until tests start citing IDs.
 */
export function checkRecords(input: {
  records: RecordEntry[];
  /** Every file whose prose may cite IDs: the records themselves and the instruction files. */
  citing: SourceFile[];
  instructions: SourceFile[];
  index?: SourceFile;
}): { errors: Problem[]; warnings: Problem[] } {
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  const byId = new Map<string, RecordEntry>();
  for (const r of input.records) {
    const seen = byId.get(r.id);
    if (seen)
      errors.push({
        file: r.file,
        message: `${r.id} is already used in ${seen.file}; IDs are never reused`,
      });
    else byId.set(r.id, r);
  }
  for (const r of input.records) {
    const { supersedes, supersededBy } = linkFields(r);
    for (const newer of supersededBy) {
      const n = byId.get(newer);
      if (!n) continue; // reported as a missing citation below
      // Superseded is set only when the replacement is accepted (docs/decisions/README.md).
      // The replacement may since have been superseded or deprecated itself; that's a chain.
      if (r.status === 'Superseded' && (n.status === 'Proposed' || n.status === 'Rejected')) {
        errors.push({
          file: r.file,
          message: `${r.id} is Superseded by ${newer}, which is ${n.status}, not Accepted`,
        });
      }
      if (!linkFields(n).supersedes.includes(r.id)) {
        errors.push({
          file: r.file,
          message: `${r.id} says it is superseded by ${newer}, but ${newer} doesn't name it in supersedes`,
        });
      }
    }
    if (supersededBy.length > 0 && r.status !== 'Superseded') {
      errors.push({
        file: r.file,
        message: `${r.id} names a superseding record but its status is ${r.status}`,
      });
    }
    if (r.status === 'Superseded' && supersededBy.length === 0) {
      errors.push({
        file: r.file,
        message: `${r.id} is Superseded but doesn't say which record replaced it`,
      });
    }
    for (const older of supersedes) {
      const o = byId.get(older);
      if (!o || r.status !== 'Accepted') continue;
      if (!linkFields(o).supersededBy.includes(r.id)) {
        errors.push({
          file: o.file,
          message: `${older} is replaced by Accepted ${r.id} but isn't marked superseded-by ${r.id}`,
        });
      }
    }
    if (
      (r.kind === 'BR' || r.kind === 'NFR') &&
      r.status === 'Accepted' &&
      !r.fields['verified by']
    ) {
      warnings.push({
        file: r.file,
        message: `${r.id} is Accepted but no test or monitor is named in Verified by`,
      });
    }
  }
  for (const f of input.citing) {
    for (const id of citedIds(f.text)) {
      if (!byId.has(id)) errors.push({ file: f.path, message: `cites ${id}, which doesn't exist` });
    }
  }
  for (const f of input.instructions) {
    const lines = f.text.trimEnd().split('\n').length;
    if (lines >= INSTRUCTION_LINE_LIMIT) {
      errors.push({
        file: f.path,
        message: `${lines} lines; instruction files stay under ${INSTRUCTION_LINE_LIMIT}`,
      });
    }
  }
  if (input.index !== undefined && input.index.text !== renderIndex(input.records)) {
    errors.push({
      file: input.index.path,
      message: 'is stale: run `bun run scripts/records.ts index`',
    });
  }
  return { errors, warnings };
}

const KIND_ORDER: Record<Kind, number> = { BR: 0, NFR: 1, DR: 2 };

function shortTitle(r: RecordEntry): string {
  if (r.title) return r.title;
  const text = r.body.replace(/\s+/g, ' ').trim();
  if (text.length <= 80) return text;
  const cut = text.lastIndexOf(' ', 79);
  return `${text.slice(0, cut > 0 ? cut : 79)} …`;
}

/** The generated index, docs/RECORDS.md. Links are relative to docs/. */
export function renderIndex(records: RecordEntry[]): string {
  const sorted = [...records].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
  const count = (s: Status): number => records.filter((r) => r.status === s).length;
  const tally = STATUSES.filter((s) => count(s) > 0)
    .map((s) => `${count(s)} ${s}`)
    .join(', ');
  const rows = sorted.map((r) => {
    const title = shortTitle(r).replace(/\|/g, '\\|');
    const link = relative('docs', r.file);
    return `| ${r.id} | ${title} | ${r.status} | [${link}](${link}) |`;
  });
  return [
    '# Records index',
    '',
    '<!-- Generated by `bun run scripts/records.ts index`. CI fails when this file is stale; do not edit it by hand. -->',
    '',
    `${records.length} records: ${tally}. How records work: [decisions/README.md](decisions/README.md).`,
    '',
    '| ID | Title | Status | File |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// Session hooks (.claude/settings.json). Pure parts first.

/** The input of an Edit, MultiEdit or Write tool call, as a PreToolUse hook receives it. */
export interface ToolEdit {
  content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  edits?: { old_string: string; new_string: string; replace_all?: boolean }[];
}

/** The file's text after the tool call, or null when an edit wouldn't apply. */
export function applyToolEdit(current: string, input: ToolEdit): string | null {
  if (typeof input.content === 'string') return input.content;
  const edits = input.edits ?? [
    {
      old_string: input.old_string ?? '',
      new_string: input.new_string ?? '',
      replace_all: input.replace_all,
    },
  ];
  let text = current;
  for (const e of edits) {
    // An Edit with an empty old_string on a missing or empty file creates it.
    if (e.old_string === '' && text === '') {
      text = e.new_string;
      continue;
    }
    if (!e.old_string || !text.includes(e.old_string)) return null;
    text = e.replace_all
      ? text.split(e.old_string).join(e.new_string)
      : text.replace(e.old_string, () => e.new_string);
  }
  return text;
}

/** True for a repo-relative path that holds records. */
export function isRecordFile(path: string): boolean {
  return (
    /^docs\/requirements\/(br|nfr)-[^/]+\.md$/.test(path) ||
    (/^docs\/decisions\/[^/]+\.md$/.test(path) && !path.endsWith('/README.md'))
  );
}

function recordsIn(path: string, text: string): Map<string, RecordEntry> {
  const list = path.startsWith('docs/decisions/')
    ? [parseDecision(path, text).record].filter((r): r is RecordEntry => r !== undefined)
    : parseRequirements(path, text).records;
  return new Map(list.map((r) => [r.id, r]));
}

function sameRecord(a: RecordEntry, b: RecordEntry): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    JSON.stringify(a.fields) === JSON.stringify(b.fields)
  );
}

/**
 * Why a change to a record file needs the founder (DR-001), or [] when it doesn't: it sets a
 * record to Accepted or Rejected, or it changes a record that is already Accepted.
 */
export function guardReasons(path: string, before: string, after: string): string[] {
  if (!isRecordFile(path)) return [];
  const was = recordsIn(path, before);
  const now = recordsIn(path, after);
  const reasons: string[] = [];
  for (const [id, r] of now) {
    const old = was.get(id);
    if ((r.status === 'Accepted' || r.status === 'Rejected') && old?.status !== r.status) {
      reasons.push(`sets ${id} to ${r.status}; only the founder accepts or rejects records`);
    } else if (old?.status === 'Accepted' && !sameRecord(old, r)) {
      reasons.push(
        `changes Accepted ${id}; beyond typo and link fixes, implemented-in notes or marking it Superseded, it changes only through a superseding record`,
      );
    }
  }
  for (const [id, r] of was) {
    if (r.status === 'Accepted' && !now.has(id))
      reasons.push(`removes Accepted ${id}; IDs are never reused or dropped`);
  }
  return reasons;
}

/**
 * The question the PreToolUse guard asks before an Edit, MultiEdit or Write to a record file,
 * or null when the edit needs no one's say. An edit it can't preview is asked about too.
 */
export function guardQuestion(path: string, before: string, tool: ToolEdit): string | null {
  if (!isRecordFile(path)) return null;
  const after = applyToolEdit(before, tool);
  if (after === null) {
    return `DR-001: the guard can't preview this edit to ${path}. Approve only if it doesn't set a record to Accepted or Rejected or change an Accepted record, or the founder asked for it.`;
  }
  const reasons = guardReasons(path, before, after);
  if (reasons.length === 0) return null;
  return `DR-001: this edit ${reasons.join('; ')}. Approve only if the founder asked for it.`;
}

/** A record path in a command, written from the repo root, from docs/, or as a bare file name. */
const RECORD_PATH =
  /\bdocs\/(decisions|requirements)\b|\b(decisions|requirements)\/|\b(br|nfr)-[a-z0-9-]+\.md\b|\b\d{3}-[a-z0-9-]+\.md\b/;

/** Shell forms that write a file. */
const SHELL_WRITE = new RegExp(
  [
    '\\bsed\\b[^|;&]*\\s(-[a-zA-Z]*i|--in-place)',
    '\\bperl\\b[^|;&]*\\s-[a-zA-Z]*i',
    '\\bawk\\b[^|;&]*-i\\s*inplace',
    '>',
    '\\b(tee|mv|cp|rm|ln|dd|ed|ex|vi|vim|install|truncate|patch)\\b',
    '\\bgit\\s+(checkout|restore|apply|mv|rm|reset|stash|am|cherry-pick|revert)\\b',
    '\\b(python3?|node|bun|deno|ruby)\\b',
  ].join('|'),
);

/**
 * True when a shell command may write to the records: it names a record path and holds a
 * write (in-place edit, redirect, tee, move, copy, delete, git restore, or a script runner).
 * Reads such as `grep` or `cat` don't count, and neither do `2>&1`, `>/dev/null`, `->` or `=>`.
 * Text matching can't see every write; the Stop hook reports status changes however made.
 */
export function bashWritesRecords(command: string): boolean {
  if (!RECORD_PATH.test(command)) return false;
  const cmd = command
    .replace(/\d*>&\d/g, '')
    .replace(/\d*>>?\s*\/dev\/null/g, '')
    .replace(/[-=]>/g, '');
  return SHELL_WRITE.test(cmd);
}

/** What a session learns at start: the tally and the decisions waiting on the founder. */
export function sessionSummary(records: RecordEntry[]): string {
  const accepted = records.filter((r) => r.status === 'Accepted').length;
  const proposed = records.filter((r) => r.status === 'Proposed');
  const open = proposed.filter((r) => r.kind === 'DR').map((r) => r.id);
  return [
    `swarmy records (DR-001): ${accepted} Accepted, ${proposed.length} Proposed. Accepted records bind; read AGENTS.md and the Accepted records for your area (docs/RECORDS.md) before planning.`,
    open.length > 0 ? `Open decisions waiting on the founder: ${open.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------------------
// CLI

const ROOT = realpathSync(join(import.meta.dir, '..'));
const INDEX_PATH = 'docs/RECORDS.md';

function readSources(dir: string, match: (name: string) => boolean): SourceFile[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((n) => n.endsWith('.md') && n !== 'README.md' && match(n))
    .sort()
    .map((n) => ({ path: `${dir}/${n}`, text: readFileSync(join(abs, n), 'utf8') }));
}

function load(): { records: RecordEntry[]; problems: Problem[]; files: SourceFile[] } {
  const records: RecordEntry[] = [];
  const problems: Problem[] = [];
  const reqFiles = readSources('docs/requirements', (n) => /^(br|nfr)-/.test(n));
  const decFiles = readSources('docs/decisions', () => true);
  for (const f of reqFiles) {
    const out = parseRequirements(f.path, f.text);
    records.push(...out.records);
    problems.push(...out.problems);
  }
  for (const f of decFiles) {
    const out = parseDecision(f.path, f.text);
    if (out.record) records.push(out.record);
    problems.push(...out.problems);
  }
  return { records, problems, files: [...reqFiles, ...decFiles] };
}

function instructionFiles(): SourceFile[] {
  const paths = ['AGENTS.md', 'CLAUDE.md'];
  const rules = join(ROOT, '.claude/rules');
  if (existsSync(rules)) {
    paths.push(
      ...readdirSync(rules)
        .filter((n) => n.endsWith('.md'))
        .sort()
        .map((n) => `.claude/rules/${n}`),
    );
  }
  return paths
    .filter((p) => existsSync(join(ROOT, p)))
    .map((p) => ({ path: p, text: readFileSync(join(ROOT, p), 'utf8') }));
}

/** The two READMEs explain the records and cite them, so their citations are checked too. */
function readmes(): SourceFile[] {
  return ['docs/decisions/README.md', 'docs/requirements/README.md']
    .filter((p) => existsSync(join(ROOT, p)))
    .map((p) => ({ path: p, text: readFileSync(join(ROOT, p), 'utf8') }));
}

function runCheck(): { count: number; failures: Problem[]; warnings: Problem[] } {
  const { records, problems, files } = load();
  const instructions = instructionFiles();
  const indexAbs = join(ROOT, INDEX_PATH);
  const { errors, warnings } = checkRecords({
    records,
    citing: [...files, ...instructions, ...readmes()],
    instructions,
    index: { path: INDEX_PATH, text: existsSync(indexAbs) ? readFileSync(indexAbs, 'utf8') : '' },
  });
  return { count: records.length, failures: [...problems, ...errors], warnings };
}

/** A tool's file path relative to the repo, through any symlink in it (macOS /tmp included). */
function repoPath(file: string): string {
  let real = file;
  try {
    real = realpathSync(file);
  } catch {
    try {
      real = join(realpathSync(dirname(file)), basename(file));
    } catch {
      // Neither the file nor its folder exists yet; keep the path as given.
    }
  }
  return relative(ROOT, real);
}

function git(args: string[]): string {
  const out = Bun.spawnSync(['git', ...args], { cwd: ROOT });
  return out.exitCode === 0 ? out.stdout.toString().trim() : '';
}

/**
 * Record changes on this branch (committed or not, against the merge-base with main) that only
 * the founder makes, as one line for the person, or '' when there are none.
 */
function founderChanges(base: string): string {
  const paths = new Set(
    [
      git([
        'diff',
        '--name-only',
        ...(base ? [base] : ['HEAD']),
        '--',
        'docs/decisions',
        'docs/requirements',
      ]),
      git([
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        'docs/decisions',
        'docs/requirements',
      ]),
    ]
      .join('\n')
      .split('\n')
      .filter(isRecordFile),
  );
  const reasons: string[] = [];
  for (const path of paths) {
    const before = git(['show', `${base || 'HEAD'}:${path}`]);
    let after = '';
    try {
      after = readFileSync(join(ROOT, path), 'utf8');
    } catch {
      // Deleted on this branch.
    }
    reasons.push(...guardReasons(path, before, after));
  }
  if (reasons.length === 0) return '';
  return `DR-001: this branch ${reasons.join('; ')}. Fine if you asked for it; otherwise revert it.`;
}

/** Paths whose changes, uncommitted or on this branch, make the Stop hook run the check. */
const WATCHED = [
  'docs/decisions',
  'docs/requirements',
  INDEX_PATH,
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/rules',
];

async function readHookInput(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(command: string): Promise<number> {
  switch (command) {
    case 'check': {
      const { count, failures, warnings } = runCheck();
      if (warnings.length > 0) {
        console.log(
          `${warnings.length} warning(s); the first: ${warnings[0]!.file}: ${warnings[0]!.message}`,
        );
      }
      for (const p of failures) console.error(`${p.file}: ${p.message}`);
      if (failures.length > 0) {
        console.error(`records check failed: ${failures.length} problem(s)`);
        return 1;
      }
      console.log(`records check passed: ${count} records`);
      return 0;
    }
    case 'index': {
      const { records, problems } = load();
      for (const p of problems) console.error(`${p.file}: ${p.message}`);
      if (problems.length > 0) return 1;
      writeFileSync(join(ROOT, INDEX_PATH), renderIndex(records));
      console.log(`${INDEX_PATH}: ${records.length} records`);
      return 0;
    }
    // SessionStart: stdout becomes context for the session.
    case 'hook-session': {
      console.log(sessionSummary(load().records));
      return 0;
    }
    // PreToolUse on Edit|MultiEdit|Write|Bash: ask the person before a change only the founder makes.
    case 'hook-guard': {
      const input = await readHookInput();
      const tool = (input.tool_input ?? {}) as ToolEdit & { file_path?: string; command?: string };
      let question: string | null = null;
      if (typeof tool.command === 'string') {
        if (bashWritesRecords(tool.command)) {
          question =
            "DR-001: this command may write to docs/decisions or docs/requirements. Approve only if it doesn't set a record to Accepted or Rejected or change an Accepted record, or the founder asked for it.";
        }
      } else if (tool.file_path) {
        const path = repoPath(tool.file_path);
        if (isRecordFile(path)) {
          let before = '';
          try {
            before = readFileSync(tool.file_path, 'utf8');
          } catch {
            // A new file: nothing to compare against.
          }
          question = guardQuestion(path, before, tool);
        }
      }
      if (question === null) return 0;
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: question,
          },
        }),
      );
      return 0;
    }
    // Stop: when records or instruction files changed, the check must pass before the session ends.
    case 'hook-stop': {
      const input = await readHookInput();
      const uncommitted = git(['status', '--porcelain', '--', ...WATCHED]);
      const base = git(['merge-base', 'origin/main', 'HEAD']);
      const committed = base ? git(['diff', '--name-only', base, 'HEAD', '--', ...WATCHED]) : '';
      if (uncommitted === '' && committed === '') return 0;
      // However a record was edited (Edit, Bash or anything else), tell the person when this
      // branch sets one to Accepted or Rejected or changes an Accepted one (DR-001).
      const notice = founderChanges(base);
      const { failures } = runCheck();
      if (failures.length === 0) {
        if (notice) console.log(JSON.stringify({ systemMessage: notice }));
        return 0;
      }
      const list = failures
        .slice(0, 5)
        .map((p) => `${p.file}: ${p.message}`)
        .join('; ');
      const reason = `The records check fails (${failures.length}): ${list}. Fix it, then run bun run scripts/records.ts check.`;
      const systemMessage = [notice, input.stop_hook_active ? reason : '']
        .filter(Boolean)
        .join(' ');
      console.log(
        JSON.stringify(
          input.stop_hook_active
            ? { systemMessage }
            : { decision: 'block', reason, ...(notice ? { systemMessage: notice } : {}) },
        ),
      );
      return 0;
    }
    default:
      console.error(
        'usage: bun run scripts/records.ts check | index | hook-session | hook-guard | hook-stop',
      );
      return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv[2] ?? 'check'));
