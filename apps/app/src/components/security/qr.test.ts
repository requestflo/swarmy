import { describe, expect, it } from 'bun:test';
import { encodeQr, qrSvgPath } from './qr';

// Golden: the matrix the `qrcode` npm package (1.5.4, byte mode, level M, auto
// mask) produces for this URI. The encoder was also compared with it for every
// forced mask across short, long and non-ASCII inputs while it was written.
const URI = 'otpauth://totp/swarmy:a%40b.io?secret=JBSWY3DPEHPK3PXP&issuer=swarmy';
const GOLDEN = [
  '1111111010010010110111000100001111111',
  '1000001011110110111100100010101000001',
  '1011101011110100000101100110101011101',
  '1011101000101001110011110100001011101',
  '1011101010010011100100101000101011101',
  '1000001000001110100010110010001000001',
  '1111111010101010101010101010101111111',
  '0000000000111010011100100101100000000',
  '1001111110011000000101101010010010111',
  '0111110101111010101000110011011111110',
  '0110011011101001101111011101100101001',
  '0101110010100100111110101011100001111',
  '0100011110001011000010011001111100101',
  '0010010101101100101001011111000110001',
  '0110001111010101001110000111101111111',
  '1001010101010011100111101000101001110',
  '1101101101100111011001110101101101111',
  '1000000010001100010000100011001000100',
  '1001001111110110110100110111000001101',
  '1101010001010001100110001100010101010',
  '0010111001110010010110101010011011110',
  '0010100111011100010100110001010010110',
  '0000001010101001000001011111010010011',
  '1010110101011001101110001000011011101',
  '0000101100011101010011101011101110010',
  '1110010000110110001101110101111011000',
  '1101111111111001000000000001111100111',
  '1011100101100010101100110011001011101',
  '1000011000101101001100110101111111001',
  '0000000010011100010101101101100011101',
  '1111111011100011111100010100101010101',
  '1000001010111111000001001101100011010',
  '1011101011111010101011010011111110011',
  '1011101010010100010011110101011000001',
  '1011101001010100010001010000110111001',
  '1000001000111111010000001010011001111',
  '1111111010101010110110010001111010101',
];

const rows = (text: string): string[] =>
  encodeQr(text).modules.map((r) => r.map((b) => (b ? '1' : '0')).join(''));

describe('encodeQr (byte mode, ECC M)', () => {
  it('matches the reference encoder module for module', () => {
    expect(rows(URI)).toEqual(GOLDEN);
  });

  it('grows the version with the payload (a real otpauth URI fits comfortably)', () => {
    expect(encodeQr('hi').size).toBe(21); // version 1
    const long = 'otpauth://totp/swarmy:owner%40example.com?secret=' + 'A'.repeat(52) + '&issuer=swarmy&digits=6&period=30';
    const qr = encodeQr(long);
    expect(qr.size).toBeGreaterThan(21);
    expect(qr.size).toBeLessThanOrEqual(57); // ≤ version 10
  });

  it('always draws the three finder patterns', () => {
    const { modules, size } = encodeQr(URI);
    for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
      expect(modules[y]!.slice(x, x + 7).every(Boolean)).toBe(true);
      expect(modules[y + 3]![x + 3]).toBe(true);
      expect(modules[y + 1]![x + 1]).toBe(false);
    }
  });

  it('renders an SVG path with a quiet zone', () => {
    const d = qrSvgPath(encodeQr('hi'));
    expect(d.startsWith('M4 4h1v1h-1z')).toBe(true);
  });
});
