import { describe, expect, it } from 'bun:test';
import { buildMessage, decodeWords, encodeWord, htmlToText, parseMime, quotedPrintable, renderTemplate } from './mime';

describe('buildMessage', () => {
  it('builds a multipart/alternative message with a Message-ID at the sending domain', () => {
    const m = buildMessage({
      from: 'Shop <noreply@example.com>',
      to: ['a@x.test'],
      subject: 'Your order ✓',
      html: '<p>Hello <b>Ada</b></p>',
      messageIdDomain: 'example.com',
      headers: { 'List-Unsubscribe': '<https://x/u>', Bcc: 'sneaky@x.test', 'Bad Header': 'x' },
    });
    expect(m.messageId).toMatch(/^<[0-9a-f]{24}@example\.com>$/);
    const p = parseMime(m.raw);
    expect(p.contentType).toBe('multipart/alternative');
    expect(p.parts.map((x) => x.contentType)).toEqual(['text/plain', 'text/html']);
    expect(p.parts[0]!.body.trim()).toBe('Hello Ada');
    expect(p.parts[1]!.body.trim()).toBe('<p>Hello <b>Ada</b></p>');
    expect(decodeWords(p.headers.get('subject')!)).toBe('Your order ✓');
    expect(p.headers.get('list-unsubscribe')).toBe('<https://x/u>');
    expect(p.headers.get('bcc')).toBeUndefined();
  });

  it('strips CR/LF from caller values (no header injection)', () => {
    const m = buildMessage({ from: 'a@example.com', to: ['b@x.test'], subject: 'hi\r\nBcc: evil@x.test', text: 'x', messageIdDomain: 'example.com' });
    expect(parseMime(m.raw).headers.get('bcc')).toBeUndefined();
  });
});

describe('encodings', () => {
  it('quoted-printable round-trips UTF-8 and long lines', () => {
    const text = `Grüße ${'x'.repeat(200)} = end`;
    const qp = quotedPrintable(text);
    expect(qp.split('\r\n').every((l) => l.length <= 76)).toBe(true);
    const p = parseMime(`Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp}`);
    expect(p.body).toBe(text);
  });
  it('encoded words only when needed', () => {
    expect(encodeWord('plain')).toBe('plain');
    expect(decodeWords(encodeWord('héllo'))).toBe('héllo');
  });
  it('htmlToText keeps links readable', () => {
    expect(htmlToText('<p>Hi</p><a href="https://x.test/v">Verify</a>')).toBe('Hi\nVerify (https://x.test/v)');
  });
});

describe('renderTemplate', () => {
  it('substitutes, escapes HTML (unless triple braces) and reports missing vars', () => {
    const r = renderTemplate('<p>Hi {{ name }}, {{{ raw }}} {{ order.id }} {{ nope }}</p>', { name: '<Ada>', raw: '<b>x</b>', order: { id: 7 } }, 'html');
    expect(r.value).toBe('<p>Hi &lt;Ada&gt;, <b>x</b> 7 </p>');
    expect(r.missing).toEqual(['nope']);
    expect(renderTemplate('Hi {{name}}', { name: '<Ada>' }, 'text').value).toBe('Hi <Ada>');
  });
});
