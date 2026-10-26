import { describe, expect, it } from 'bun:test';
import { PUBLIC_CONFIRM_CODE, publicConfirmRefusal } from './bucket-public-confirm';

const ask = (from: string, to: string, confirm: string | null | undefined) => publicConfirmRefusal({ bucket: 'storefront-media', from, to, confirm });

describe('publicConfirmRefusal — a person types the bucket name to make it public', () => {
  it('moving to public without the name (or with the wrong one) is refused, naming the risk and the phrase', () => {
    for (const confirm of [null, '', 'storefront', 'STOREFRONT-MEDIA']) {
      const e = ask('INTERNAL', 'PUBLIC', confirm);
      expect(e?.code).toBe('PRECONDITION_FAILED');
      expect(e?.message).toContain('reachable from the internet');
      expect(e?.message).toContain('type storefront-media to confirm');
      expect(e?.cause).toMatchObject({ swarmyCode: PUBLIC_CONFIRM_CODE, phrase: 'storefront-media' });
    }
    expect(ask('MESH', 'PUBLIC', null)).not.toBeNull();
  });

  it('the name typed back (spaces trimmed) lets it through', () => {
    expect(ask('INTERNAL', 'PUBLIC', 'storefront-media')).toBeNull();
    expect(ask('MESH', 'PUBLIC', '  storefront-media ')).toBeNull();
  });

  it('only moving TO public asks: narrowing, private network and staying public never do', () => {
    expect(ask('PUBLIC', 'INTERNAL', null)).toBeNull();
    expect(ask('PUBLIC', 'MESH', null)).toBeNull();
    expect(ask('INTERNAL', 'MESH', null)).toBeNull();
    expect(ask('PUBLIC', 'PUBLIC', null)).toBeNull();
  });

  it('no confirm at all is the swarmy.yaml apply (a reviewed pull request), not a person', () => {
    expect(ask('INTERNAL', 'PUBLIC', undefined)).toBeNull();
  });
});
