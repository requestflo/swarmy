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
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

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
// CLI

const ROOT = join(import.meta.dir, '..');
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

function main(command: string): number {
  const { records, problems, files } = load();
  if (command === 'index') {
    if (problems.length > 0) {
      for (const p of problems) console.error(`${p.file}: ${p.message}`);
      return 1;
    }
    writeFileSync(join(ROOT, INDEX_PATH), renderIndex(records));
    console.log(`${INDEX_PATH}: ${records.length} records`);
    return 0;
  }
  if (command !== 'check') {
    console.error('usage: bun run scripts/records.ts check | index');
    return 2;
  }
  const instructions = instructionFiles();
  const indexAbs = join(ROOT, INDEX_PATH);
  const { errors, warnings } = checkRecords({
    records,
    citing: [...files, ...instructions, ...readmes()],
    instructions,
    index: { path: INDEX_PATH, text: existsSync(indexAbs) ? readFileSync(indexAbs, 'utf8') : '' },
  });
  const all = [...problems, ...errors];
  if (warnings.length > 0)
    console.log(
      `${warnings.length} warning(s); the first: ${warnings[0]!.file}: ${warnings[0]!.message}`,
    );
  for (const p of all) console.error(`${p.file}: ${p.message}`);
  if (all.length > 0) {
    console.error(`records check failed: ${all.length} problem(s)`);
    return 1;
  }
  console.log(`records check passed: ${records.length} records`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv[2] ?? 'check'));
