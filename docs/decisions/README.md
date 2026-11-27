# Decision records

Every product, architecture, security and process decision in swarmy has a permanent
`DR-NNN` ID and a status. This is DR-001. Requirements live next door in
[`../requirements/`](../requirements/README.md); every record is listed in
[`../RECORDS.md`](../RECORDS.md).

## Records

| Record                     | ID        | Holds                                                                          | Lives in                                    |
| -------------------------- | --------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| Business requirement       | `BR-NNN`  | What swarmy must do, with testable "WHEN … THE SYSTEM SHALL …" criteria        | `docs/requirements/br-<area>.md`            |
| Non-functional requirement | `NFR-NNN` | A measurable quality target, filed under its ISO/IEC 25010:2023 characteristic | `docs/requirements/nfr-<characteristic>.md` |
| Decision record            | `DR-NNN`  | A decision, its reasons and the options turned down                            | `docs/decisions/NNN-<title>.md` (MADR 4.0)  |

IDs are never reused or renumbered. Titles can change; IDs can't. Each BR and NFR has a
revision number that rises whenever its meaning changes, which flags every test citing it
for a re-check.

## Statuses

| Status     | What it means                                             | Who sets it                          |
| ---------- | --------------------------------------------------------- | ------------------------------------ |
| Proposed   | Context only; nothing is built on it                      | Anyone, including an agent           |
| Accepted   | Binding; changing it needs a superseding record           | The founder only                     |
| Rejected   | Not doing it; the reasons stay so it isn't proposed again | The founder only                     |
| Superseded | Replaced by the record it names                           | Set when the replacement is accepted |
| Deprecated | No longer applies and has no replacement                  | The founder only                     |

## How a decision changes

1. **Trigger.** New evidence appears, a record's revisit condition fires, or the founder
   asks. Mid-task, an agent only flags it.
2. **Draft.** A new Proposed record names the one it replaces (`supersedes: DR-007`), what
   changed, and every requirement and piece of code it affects.
3. **Decide.** The founder accepts or rejects proposals, in a batch if there are several
   ("accept DR-020 to DR-026").
4. **Apply.** In one pull request, the new record becomes Accepted, the old one becomes
   Superseded with `superseded-by:` pointing at it, and everything citing it is updated.

An Accepted record may only be edited to fix typos or links, add "implemented in" notes, or
mark it Superseded or Deprecated.

## Rules for every agent session

- Read `AGENTS.md`, [`../RECORDS.md`](../RECORDS.md) and every Accepted record covering the
  work before planning.
- On a conflict with an Accepted record, stop, cite its ID, and offer to change the task or
  draft a superseding record. Never work around it.
- Never set a status to Accepted or Rejected.
- Change code and the records it affects in the same pull request.
- Cite IDs in tests, in comments at deliberate oddities, in commit trailers
  (`Refs: BR-012, DR-007`) and in pull requests.
- A decision agreed in chat isn't a decision until it's written down as Proposed.

When sources disagree, an Accepted record wins, then the product doc, then the skill, then
the plan.

## File format

MADR 4.0 with swarmy's front matter:

```markdown
---
id: DR-061
status: proposed # proposed | accepted | rejected | superseded | deprecated
date: 2026-12-01
decision-makers: founder
affects: BR-037, NFR-020 # optional
supersedes: DR-021 # optional; the replaced record says superseded-by: DR-061
---

# DR-061: Short title

## Context and Problem Statement

## Considered Options

## Decision Outcome
```

The file name is the ID's number plus a slug of the title. `bun run scripts/records.ts check`
validates every record, and `bun run scripts/records.ts index` regenerates `docs/RECORDS.md`.
CI runs the check on every pull request.
