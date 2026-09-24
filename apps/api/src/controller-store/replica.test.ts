import { describe, expect, it } from 'bun:test';
import { headTxidFromKeys, parseMarker } from './replica';

describe('headTxidFromKeys', () => {
  it('takes the highest max-TXID across levels (S3 and local layouts)', () => {
    expect(
      headTxidFromKeys([
        'control/db/0000/0000000000000001-0000000000000001.ltx',
        'control/db/0001/0000000000000002-00000000000000ff.ltx',
        'control/db/0009/0000000000000001-0000000000000010.ltx',
        'x/ltx/0/0000000000000100-0000000000000101.ltx',
        'control/writer.json',
      ]),
    ).toBe(0x101n);
  });
  it('no LTX files = 0 (no data)', () => {
    expect(headTxidFromKeys(['control/writer.json'])).toBe(0n);
  });
});

describe('parseMarker', () => {
  it('accepts holder+epoch, rejects junk', () => {
    expect(parseMarker('{"holder":"t","epoch":2}')).toEqual({ holder: 't', epoch: 2 });
    expect(parseMarker('{"holder":"t"}')).toBeNull();
    expect(parseMarker('nope')).toBeNull();
  });
});
