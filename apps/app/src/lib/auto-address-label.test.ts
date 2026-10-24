import { describe, expect, it } from 'bun:test';
import { autoAddressLabel } from './auto-address-label';

describe('autoAddressLabel', () => {
  it('calls sslip.io / nip.io names what they are', () => {
    expect(autoAddressLabel('web-shop.203-0-113-10.sslip.io')).toBe('public convenience name · sslip.io');
    expect(autoAddressLabel('WEB.1-2-3-4.NIP.IO.')).toBe('public convenience name · nip.io');
  });
  it('a cluster-zone or own-zone address is just an automatic address', () => {
    expect(autoAddressLabel('web-shop.5-9-10-200.apps.example.com')).toBe('automatic address');
    expect(autoAddressLabel('web-shop.example.com')).toBe('automatic address');
    expect(autoAddressLabel('sslip.io.example.com')).toBe('automatic address');
  });
});
