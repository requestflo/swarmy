import { describe, expect, it } from 'bun:test';
import {
  applyToolEdit,
  checkRecords,
  citedIds,
  guardReasons,
  isRecordFile,
  parseDecision,
  parseRequirements,
  renderIndex,
  sessionSummary,
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
    const text = Array.from({ length: 201 }, (_, i) => `line ${i}`).join('\n');
    const { errors } = checkRecords({
      ...none,
      records: [],
      instructions: [{ path: 'AGENTS.md', text }],
    });
    expect(errors.map((e) => e.message)).toEqual(['201 lines; instruction files stay under 200']);
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

describe('applyToolEdit', () => {
  it('applies Write, Edit and MultiEdit inputs the way the tools do', () => {
    expect(applyToolEdit('old', { content: 'new' })).toBe('new');
    expect(applyToolEdit('a b a', { old_string: 'a', new_string: 'c' })).toBe('c b a');
    expect(applyToolEdit('a b a', { old_string: 'a', new_string: 'c', replace_all: true })).toBe(
      'c b c',
    );
    expect(
      applyToolEdit('a b', {
        edits: [
          { old_string: 'a', new_string: 'x' },
          { old_string: 'b', new_string: 'y' },
        ],
      }),
    ).toBe('x y');
    expect(applyToolEdit('a b', { old_string: 'z', new_string: 'y' })).toBeNull();
  });
});

describe('guardReasons (DR-001: only the founder accepts, rejects or rewrites an Accepted record)', () => {
  it('only watches record files', () => {
    expect(isRecordFile('docs/requirements/br-sample.md')).toBe(true);
    expect(isRecordFile('docs/decisions/007-enrolment.md')).toBe(true);
    expect(isRecordFile('docs/decisions/README.md')).toBe(false);
    expect(isRecordFile('docs/requirements/README.md')).toBe(false);
    expect(guardReasons('AGENTS.md', '', '- Status: Accepted')).toEqual([]);
  });

  it('asks when a record becomes Accepted or Rejected', () => {
    const after = BR_TEXT.replace(
      '- Status: Proposed\n- Revision: 2',
      '- Status: Accepted\n- Revision: 2',
    );
    expect(guardReasons(BR_FILE, BR_TEXT, after)).toEqual([
      'sets BR-002 to Accepted; only the founder accepts or rejects records',
    ]);
    const rejected = DR_TEXT.replace('status: accepted', 'status: rejected');
    expect(guardReasons(DR_FILE, DR_TEXT, rejected)).toEqual([
      'sets DR-007 to Rejected; only the founder accepts or rejects records',
    ]);
  });

  it('asks when an Accepted record changes or disappears', () => {
    const reworded = BR_TEXT.replace(
      'Config lives on Docker labels',
      'Config lives in the database',
    );
    expect(guardReasons(BR_FILE, BR_TEXT, reworded)[0]).toStartWith('changes Accepted BR-001;');
    const dropped = BR_TEXT.slice(BR_TEXT.indexOf('## BR-002'));
    expect(guardReasons(BR_FILE, BR_TEXT, dropped)).toEqual([
      'removes Accepted BR-001; IDs are never reused or dropped',
    ]);
  });

  it('lets a Proposed record change freely, and lets a new Proposed record be added', () => {
    const edited = BR_TEXT.replace('show it online', 'show it online within a minute');
    expect(guardReasons(BR_FILE, BR_TEXT, edited)).toEqual([]);
    const added = `${BR_TEXT}\n## BR-003\n\n- Status: Proposed\n- Revision: 1\n\nWHEN x, THE SYSTEM SHALL y.\n`;
    expect(guardReasons(BR_FILE, BR_TEXT, added)).toEqual([]);
  });
});

describe('sessionSummary', () => {
  it('tallies records and lists the open decisions', () => {
    const text = sessionSummary([
      rec('BR-001', { status: 'Accepted' }),
      rec('BR-002'),
      rec('DR-041'),
      rec('DR-047'),
    ]);
    expect(text).toContain('1 Accepted, 3 Proposed');
    expect(text).toContain('Open decisions waiting on the founder: DR-041, DR-047.');
  });
});
