import { describe, expect, it } from 'bun:test';
import { blockedAddressReason, checkProviderUrl, type HostResolver } from './ai-url-guard';

const dns = (map: Record<string, string[]>): HostResolver => async (h) => {
  const hit = map[h];
  if (!hit) throw new Error('ENOTFOUND');
  return hit;
};

describe('blockedAddressReason — SSRF address classes', () => {
  it.each([
    '127.0.0.1',
    '127.8.9.10',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.100.100.200',
    '::',
    '::1',
    'fe80::1',
    'fd00:ec2::254',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    'ff02::1',
    '224.0.0.1',
  ])('blocks %s', (ip) => {
    expect(blockedAddressReason(ip)).not.toBeNull();
  });

  it.each(['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(blockedAddressReason(ip)).toBeNull();
  });
});

describe('checkProviderUrl', () => {
  const resolve = dns({
    'api.openai.com': ['104.18.7.192'],
    'evil.example': ['169.254.169.254'],
    'mixed.example': ['1.1.1.1', '10.0.0.5'],
    'v6.example': ['::1'],
  });

  it('accepts a public https base URL', async () => {
    const r = await checkProviderUrl('https://api.openai.com', { resolve });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['ftp://api.openai.com', 'only http(s)'],
    ['file:///etc/passwd', 'only http(s)'],
    ['https://user:pw@api.openai.com', 'credentials'],
    ['https://api.openai.com/?x=1', 'query'],
    ['https://api.openai.com/#frag', 'fragment'],
    ['http://localhost:11434', 'internal'],
    ['http://metadata.google.internal', 'internal'],
    ['http://127.0.0.1:3021', 'loopback'],
    ['http://[::1]:8080', 'loopback'],
    ['http://169.254.169.254/latest', 'link-local'],
    ['https://evil.example', 'link-local'],
    ['https://mixed.example', 'private'],
    ['https://v6.example', 'loopback'],
    ['https://nowhere.example', 'does not resolve'],
    ['not a url', 'valid URL'],
  ])('refuses %s', async (url, why) => {
    const r = await checkProviderUrl(url, { resolve });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
  });

  it('allows a query only when asked (built request URLs)', async () => {
    const r = await checkProviderUrl('https://api.openai.com/openai/models?api-version=1', { resolve, allowQuery: true });
    expect(r.ok).toBe(true);
  });

  it('lets the org’s in-cluster engines through without the address check', async () => {
    const r = await checkProviderUrl('http://ai_ollama:11434', { resolve: dns({ ai_ollama: ['10.0.1.7'] }), allowHosts: ['ai_ollama'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.allowlisted).toBe(true);
    const other = await checkProviderUrl('http://other_svc:11434', { resolve: dns({ other_svc: ['10.0.1.8'] }), allowHosts: ['ai_ollama'] });
    expect(other.ok).toBe(false);
  });
});
