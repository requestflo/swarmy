import { describe, expect, it } from 'bun:test';
import dnsPacket from 'dns-packet';
import { decodeTxtAnswers, encodeTxtQuery } from './probe';

// rcode rides in the low 4 bits of the header flags (3 = NXDOMAIN, 2 = SERVFAIL).
const reply = (extra: Record<string, unknown>, rcode = 0) =>
  dnsPacket.encode({ id: 1, type: 'response', flags: dnsPacket.RECURSION_DESIRED | rcode, questions: [{ name: 'k._domainkey.a.test', type: 'TXT' }], ...extra } as never);

describe('TXT probe (email DNS checks)', () => {
  it('asks recursively for TXT', () => {
    const q = dnsPacket.decode(encodeTxtQuery('k._domainkey.a.test', 7));
    expect(q.questions?.[0]).toMatchObject({ name: 'k._domainkey.a.test', type: 'TXT' });
    expect((q.flags ?? 0) & dnsPacket.RECURSION_DESIRED).toBeTruthy();
  });
  it('joins the strings of one record and keeps records apart', () => {
    const long = 'v=DKIM1; k=rsa; p=' + 'A'.repeat(390);
    const buf = reply({
      answers: [
        { name: 'k._domainkey.a.test', type: 'TXT', data: [long.slice(0, 255), long.slice(255)] },
        { name: 'k._domainkey.a.test', type: 'TXT', data: ['second'] },
      ],
    });
    expect(decodeTxtAnswers(buf)).toEqual([long, 'second']);
  });
  it('NXDOMAIN is no records; SERVFAIL and garbage fall back', () => {
    expect(decodeTxtAnswers(reply({}, 3))).toEqual([]);
    expect(decodeTxtAnswers(reply({}, 2))).toBeNull();
    expect(decodeTxtAnswers(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
