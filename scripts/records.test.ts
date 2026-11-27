import { describe, expect, it } from 'bun:test';
import {
  checkRecords,
  citedIds,
  parseDecision,
  parseRequirements,
  renderIndex,
  type RecordEntry,
} from './records';

const BR_FILE = 'docs/requirements/br-sample.md';
const BR_TEXT = `# Business requirements: sample

## BR-001 · Docker is the source of truth

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Config lives on Docker labels, configs and secrets.

## BR-002

- Status: Proposed
- Revision: 2
- Built: Shipped

WHEN a node joins, THE SYSTEM SHALL show it online.
`;

const DR_FILE = 'docs/decisions/007-enrolment.md';
const DR_TEXT = `---
id: DR-007
status: accepted
date: 2026-11-27
decision-makers: founder
---

# DR-007: Enrolment

## Decision Outcome

Chosen option: a pasted one-liner, because the agent dials out (BR-001).
`;

function rec(id: string, extra: Partial<RecordEntry> = {}): RecordEntry {
  const kind = id.split('-')[0] as RecordEntry['kind'];
  return {
    id,
    kind,
    title: id,
    status: 'Proposed',
    file: `docs/x/${id}.md`,
    fields: {},
    body: 'text',
    ...extra,
  };
}

// Every test here proves the DR-001 record system: the rules live in docs/decisions/README.md.

describe('parseRequirements', () => {
  it('reads each heading, its fields and its text', () => {
    const { records, problems } = parseRequirements(BR_FILE, BR_TEXT);
    expect(problems).toEqual([]);
    expect(records.map((r) => [r.id, r.title, r.status, r.fields.revision])).toEqual([
      ['BR-001', 'Docker is the source of truth', 'Accepted', '1'],
      ['BR-002', '', 'Proposed', '2'],
    ]);
    expect(records[1]!.body).toBe('WHEN a node joins, THE SYSTEM SHALL show it online.');
  });

  it('refuses a record with no status, an unknown status or no revision', () => {
    const text =
      '## BR-003\n\n- Revision: 1\n\nText.\n\n## BR-004\n\n- Status: Maybe\n- Revision: 0\n\nText.\n';
    const { records, problems } = parseRequirements(BR_FILE, text);
    expect(records).toEqual([]);
    expect(problems.map((p) => p.message)).toEqual([
      'BR-003 has no Status field',
      'BR-004 has an unknown status "Maybe"',
      'BR-004 needs a Revision field holding a whole number from 1',
    ]);
  });

  it('reads a CRLF checkout the same as LF', () => {
    const lf = parseRequirements(BR_FILE, BR_TEXT);
    const crlf = parseRequirements(BR_FILE, BR_TEXT.replace(/\n/g, '\r\n'));
    expect(crlf).toEqual(lf);
  });

  it('reads a hyphenated field name', () => {
    const text =
      '## BR-005\n\n- Status: Proposed\n- Superseded-by: BR-006\n- Revision: 1\n\nText.\n';
    const { records, problems } = parseRequirements(BR_FILE, text);
    expect(problems).toEqual([]);
    expect(records[0]!.fields['superseded-by']).toBe('BR-006');
  });

  it('keeps NFRs in nfr- files and requires their Target', () => {
    const { problems } = parseRequirements(
      BR_FILE,
      '## NFR-001 · Footprint\n\n- Status: Proposed\n- Revision: 1\n',
    );
    expect(problems.map((p) => p.message)).toEqual([
      'NFR-001 belongs in a nfr-*.md file',
      'NFR-001 has no Target field',
    ]);
  });
});

describe('parseDecision', () => {
  it('reads MADR front matter and the title', () => {
    const { record, problems } = parseDecision(DR_FILE, DR_TEXT);
    expect(problems).toEqual([]);
    expect([record?.id, record?.status, record?.title]).toEqual([
      'DR-007',
      'Accepted',
      'Enrolment',
    ]);
  });

  it('reads CRLF files and quoted values the way YAML does', () => {
    const quoted = DR_TEXT.replace('status: accepted', 'status: "accepted"').replace(
      'id: DR-007',
      "id: 'DR-007'",
    );
    const { record, problems } = parseDecision(DR_FILE, quoted.replace(/\n/g, '\r\n'));
    expect(problems).toEqual([]);
    expect([record?.id, record?.status]).toEqual(['DR-007', 'Accepted']);
  });

  it('refuses a file whose name or heading disagrees with its id', () => {
    const { record, problems } = parseDecision(
      'docs/decisions/008-enrolment.md',
      DR_TEXT.replace('# DR-007', '# DR-009'),
    );
    expect(record).toBeUndefined();
    expect(problems.map((p) => p.message)).toEqual([
      'file name must start with 007- to match DR-007',
      'heading says DR-009 but front matter says DR-007',
    ]);
  });
});

describe('citedIds', () => {
  it('finds citations in prose and skips examples in code', () => {
    const text =
      'Per BR-012 and DR-007. Trailer `Refs: BR-999`.\n```\nid: DR-061\n```\nAlso NFR-020.';
    expect(citedIds(text)).toEqual(['BR-012', 'DR-007', 'NFR-020']);
    expect(citedIds('See DR-002.\n~~~\nsupersedes: DR-999\n~~~\n')).toEqual(['DR-002']);
  });
});

describe('checkRecords', () => {
  const none = { citing: [], instructions: [] };

  it('never lets an ID be used twice', () => {
    const { errors } = checkRecords({
      ...none,
      records: [rec('BR-001'), rec('BR-001', { file: 'docs/y.md' })],
    });
    expect(errors.map((e) => e.message)).toEqual([
      'BR-001 is already used in docs/x/BR-001.md; IDs are never reused',
    ]);
  });

  it('requires supersede links on both sides', () => {
    const old = rec('DR-021', { status: 'Accepted' });
    const replacement = rec('DR-061', { status: 'Accepted', fields: { supersedes: 'DR-021' } });
    expect(
      checkRecords({ ...none, records: [old, replacement] }).errors.map((e) => e.message),
    ).toEqual(["DR-021 is replaced by Accepted DR-061 but isn't marked superseded-by DR-061"]);
    const done = rec('DR-021', { status: 'Superseded', fields: { 'superseded-by': 'DR-061' } });
    expect(checkRecords({ ...none, records: [done, replacement] }).errors).toEqual([]);
  });

  it('marks a record Superseded only when its replacement is Accepted', () => {
    const replaced = rec('DR-021', { status: 'Superseded', fields: { 'superseded-by': 'DR-061' } });
    for (const status of ['Proposed', 'Rejected'] as const) {
      const replacement = rec('DR-061', { status, fields: { supersedes: 'DR-021' } });
      expect(
        checkRecords({ ...none, records: [replaced, replacement] }).errors.map((e) => e.message),
      ).toEqual([`DR-021 is Superseded by DR-061, which is ${status}, not Accepted`]);
    }
  });

  it('lets a Proposed replacement name the record it would replace', () => {
    const proposal = rec('DR-061', { fields: { supersedes: 'DR-021' } });
    expect(
      checkRecords({ ...none, records: [rec('DR-021', { status: 'Accepted' }), proposal] }).errors,
    ).toEqual([]);
  });

  it('fails on a cited ID that does not exist', () => {
    const { errors } = checkRecords({
      ...none,
      records: [rec('BR-001')],
      citing: [{ path: 'AGENTS.md', text: 'Obey BR-001 and DR-404.' }],
    });
    expect(errors).toEqual([{ file: 'AGENTS.md', message: "cites DR-404, which doesn't exist" }]);
  });

  it('keeps instruction files under 200 lines', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const { errors } = checkRecords({
      ...none,
      records: [],
      instructions: [{ path: 'AGENTS.md', text }],
    });
    expect(errors.map((e) => e.message)).toEqual(['200 lines; instruction files stay under 200']);
    const ok = { path: 'AGENTS.md', text: text.split('\n').slice(1).join('\n') };
    expect(checkRecords({ ...none, records: [], instructions: [ok] }).errors).toEqual([]);
  });

  it('fails when the index is stale and passes when it matches', () => {
    const records = [rec('BR-001')];
    expect(
      checkRecords({ ...none, records, index: { path: 'docs/RECORDS.md', text: 'old' } }).errors,
    ).toHaveLength(1);
    expect(
      checkRecords({
        ...none,
        records,
        index: { path: 'docs/RECORDS.md', text: renderIndex(records) },
      }).errors,
    ).toEqual([]);
  });

  it('warns, but does not fail, on an Accepted requirement with no Verified by', () => {
    const out = checkRecords({ ...none, records: [rec('BR-001', { status: 'Accepted' })] });
    expect(out.errors).toEqual([]);
    expect(out.warnings.map((w) => w.message)).toEqual([
      'BR-001 is Accepted but no test or monitor is named in Verified by',
    ]);
  });
});

describe('renderIndex', () => {
  it('cuts an untitled record with no spaces to 79 characters', () => {
    const body = 'x'.repeat(200);
    const index = renderIndex([
      rec('BR-001', { title: '', body, file: 'docs/requirements/br-a.md' }),
    ]);
    expect(index).toContain(`| BR-001 | ${'x'.repeat(79)} … | Proposed |`);
  });

  it('sorts BR, NFR then DR by number and tallies statuses', () => {
    const index = renderIndex([
      rec('DR-002', { status: 'Accepted', file: 'docs/decisions/002-x.md' }),
      rec('NFR-001', { file: 'docs/requirements/nfr-a.md' }),
      rec('BR-010', { file: 'docs/requirements/br-a.md', title: '', body: 'A | B' }),
      rec('BR-002', { file: 'docs/requirements/br-a.md' }),
    ]);
    expect(index).toContain('4 records: 3 Proposed, 1 Accepted.');
    const rows = index.split('\n').filter((l) => /^\| (BR|NFR|DR)-/.test(l));
    expect(rows).toEqual([
      '| BR-002 | BR-002 | Proposed | [requirements/br-a.md](requirements/br-a.md) |',
      '| BR-010 | A \\| B | Proposed | [requirements/br-a.md](requirements/br-a.md) |',
      '| NFR-001 | NFR-001 | Proposed | [requirements/nfr-a.md](requirements/nfr-a.md) |',
      '| DR-002 | DR-002 | Accepted | [decisions/002-x.md](decisions/002-x.md) |',
    ]);
  });
});
