import { describe, expect, it } from 'bun:test';
import { channelResultWords } from './alert-receipt';

describe('channelResultWords: a test receipt in plain words', () => {
  it('says it arrived', () => {
    expect(channelResultWords(true, 'delivered (HTTP 200)')).toBe('Delivered: the service accepted it.');
    expect(channelResultWords(true, 'sent email to ops@northwind.dev')).toBe('Sent to ops@northwind.dev.');
  });

  it('turns HTTP answers into what to do', () => {
    expect(channelResultWords(false, 'HTTP 404')).toBe('That address no longer exists; the webhook may have been deleted. Paste a new one.');
    expect(channelResultWords(false, 'HTTP 403: invalid_token')).toContain('refused the credentials');
    expect(channelResultWords(false, 'HTTP 429')).toContain('rate-limiting');
    expect(channelResultWords(false, 'HTTP 502')).toBe('The service had a problem on its side (HTTP 502). Try again shortly.');
    expect(channelResultWords(false, 'HTTP 400: Bad Request: chat not found')).toBe('The service turned the message down: Bad Request: chat not found.');
  });

  it('names timeouts, unreachable hosts, bad certificates and missing setup', () => {
    expect(channelResultWords(false, 'The operation timed out.')).toContain('No answer within 6 s');
    expect(channelResultWords(false, 'getaddrinfo ENOTFOUND hooks.example.invalid')).toContain('couldn’t reach that address');
    expect(channelResultWords(false, 'unable to verify the first certificate')).toContain('certificate');
    expect(channelResultWords(false, 'channel destination is not configured')).toContain('no destination saved');
    expect(channelResultWords(false, 'email not sent: disabled — turn on Email and verify a domain')).toContain('Turn on Email');
  });

  it('passes anything else through as a sentence', () => {
    expect(channelResultWords(false, 'unsupported channel kind pager')).toBe('unsupported channel kind pager.');
  });
});
