import { describe, expect, it } from 'bun:test';
import {
  extractGroupKey,
  incidentTitleForGroup,
  kindIndicatesResolution,
  matchOpenIncident,
  opensIncident,
} from './incidents-record';
import { incidentDurationSec, toSeverityView } from './incidents.service';

describe('opensIncident — only critical events open a new incident', () => {
  it('critical opens', () => {
    expect(opensIncident('critical')).toBe(true);
  });
  it('warning does not open', () => {
    expect(opensIncident('warning')).toBe(false);
  });
  it('unspecified severity does not open', () => {
    expect(opensIncident(undefined)).toBe(false);
  });
});

describe('kindIndicatesResolution — resolution kinds close the story', () => {
  it('matches the bare `resolved` kind', () => {
    expect(kindIndicatesResolution('resolved')).toBe(true);
  });
  it('matches namespaced `*.resolved` kinds (alert-evaluator recovery)', () => {
    expect(kindIndicatesResolution('alert.resolved')).toBe(true);
  });
  it('does not match firing / rollback / note kinds', () => {
    expect(kindIndicatesResolution('alert.fired')).toBe(false);
    expect(kindIndicatesResolution('deploy.gate.rollback')).toBe(false);
    expect(kindIndicatesResolution('note')).toBe(false);
    expect(kindIndicatesResolution('reopened')).toBe(false);
  });
  it('does not match kinds merely containing the word', () => {
    expect(kindIndicatesResolution('resolvedish')).toBe(false);
    expect(kindIndicatesResolution('unresolved')).toBe(false);
  });
});

describe('extractGroupKey — pull the correlation key from event meta', () => {
  it('reads a string groupKey', () => {
    expect(extractGroupKey({ groupKey: 'db:main', from: 'pg-0' })).toBe('db:main');
  });
  it('rejects empty / non-string keys', () => {
    expect(extractGroupKey({ groupKey: '' })).toBeNull();
    expect(extractGroupKey({ groupKey: 42 })).toBeNull();
  });
  it('rejects non-object meta shapes', () => {
    expect(extractGroupKey(null)).toBeNull();
    expect(extractGroupKey(undefined)).toBeNull();
    expect(extractGroupKey('db:main')).toBeNull();
    expect(extractGroupKey(['db:main'])).toBeNull();
  });
});

describe('incidentTitleForGroup — human titles from groupKey conventions', () => {
  it('db:<cluster> (A2 failover)', () => {
    expect(incidentTitleForGroup('db:main-db')).toBe('Database cluster main-db disruption');
  });
  it('release:<stack> (D1 deploy safety)', () => {
    expect(incidentTitleForGroup('release:shop-api')).toBe('Failed deploy on shop-api');
  });
  it('alert:<kind>:<name> (C3 evaluator resources)', () => {
    expect(incidentTitleForGroup('alert:node:london-1')).toBe('Node london-1 disruption');
    expect(incidentTitleForGroup('alert:service:web')).toBe('Service web disruption');
  });
  it('alert:<flat-resource> falls back to a generic alert title', () => {
    expect(incidentTitleForGroup('alert:ingress')).toBe('Alert on ingress');
  });
  it('unknown prefixes and bare keys fall back to the raw key', () => {
    expect(incidentTitleForGroup('custom:thing')).toBe('Incident: custom:thing');
    expect(incidentTitleForGroup('no-colon')).toBe('Incident: no-colon');
    expect(incidentTitleForGroup(':weird')).toBe('Incident: :weird');
  });
});

describe('matchOpenIncident — groupKey matching over open incidents', () => {
  const incidents = [
    { id: 'i1', events: [{ meta: { groupKey: 'db:main' } }] },
    { id: 'i2', events: [{ meta: { groupKey: 'alert:node:london-1' } }] },
    { id: 'i3', events: [{ meta: {} }] },
  ];

  it('finds the incident whose opening event carries the key', () => {
    expect(matchOpenIncident(incidents, 'db:main')?.id).toBe('i1');
    expect(matchOpenIncident(incidents, 'alert:node:london-1')?.id).toBe('i2');
  });
  it('returns null when no open incident matches', () => {
    expect(matchOpenIncident(incidents, 'release:shop-api')).toBeNull();
    expect(matchOpenIncident([], 'db:main')).toBeNull();
  });
  it('ignores incidents whose events carry no key (manual rows)', () => {
    expect(matchOpenIncident([incidents[2]!], 'db:main')).toBeNull();
  });
  it('matches any carried event, not only the first', () => {
    const multi = [{ id: 'i4', events: [{ meta: {} }, { meta: { groupKey: 'db:aux' } }] }];
    expect(matchOpenIncident(multi, 'db:aux')?.id).toBe('i4');
  });
});

describe('incidentDurationSec — open vs resolved spans', () => {
  const opened = new Date('2026-07-01T14:01:00Z');

  it('resolved incidents span open→resolved', () => {
    expect(incidentDurationSec(opened, new Date('2026-07-01T14:05:00Z'))).toBe(240);
  });
  it('open incidents span open→now', () => {
    const now = new Date('2026-07-01T14:11:30Z');
    expect(incidentDurationSec(opened, null, now)).toBe(630);
  });
  it('never goes negative on clock skew', () => {
    expect(incidentDurationSec(opened, new Date('2026-07-01T14:00:00Z'))).toBe(0);
  });
});

describe('toSeverityView — clamp free-form severities to the view vocabulary', () => {
  it('passes known severities through', () => {
    expect(toSeverityView('critical')).toBe('critical');
    expect(toSeverityView('major')).toBe('major');
    expect(toSeverityView('minor')).toBe('minor');
  });
  it('clamps unknown strings to major (the schema default)', () => {
    expect(toSeverityView('sev1')).toBe('major');
    expect(toSeverityView('')).toBe('major');
  });
});
