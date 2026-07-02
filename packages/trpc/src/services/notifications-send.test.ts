import { describe, expect, it } from 'bun:test';
import {
  escapeHtml,
  interpolate,
  parseNotifyMeta,
  renderTemplate,
} from './notifications-send';

describe('escapeHtml', () => {
  it('escapes the five html-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('All green, Calum. 3 nodes online')).toBe(
      'All green, Calum. 3 nodes online',
    );
  });
});

describe('interpolate — {{var}} substitution', () => {
  it('substitutes simple placeholders', () => {
    expect(interpolate('Hello {{name}}!', { name: 'Ada' })).toBe('Hello Ada!');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(interpolate('{{ name }} / {{  name}}', { name: 'x' })).toBe('x / x');
  });

  it('substitutes the same placeholder multiple times', () => {
    expect(interpolate('{{a}}-{{a}}-{{a}}', { a: 'y' })).toBe('y-y-y');
  });

  it('allows dots, dashes and underscores in names', () => {
    expect(
      interpolate('{{svc.name}} {{node-id}} {{a_b}}', {
        'svc.name': 'web',
        'node-id': 'n1',
        a_b: 'ok',
      }),
    ).toBe('web n1 ok');
  });

  it('leaves unknown placeholders verbatim (typos stay visible)', () => {
    expect(interpolate('Hi {{who}}', {})).toBe('Hi {{who}}');
    expect(interpolate('Hi {{who}}', undefined)).toBe('Hi {{who}}');
  });

  it('does not escape values by default (text bodies)', () => {
    expect(interpolate('{{v}}', { v: '<b>&</b>' })).toBe('<b>&</b>');
  });

  it('escapes substituted values (not the template) when escape is set', () => {
    expect(interpolate('<p>{{v}}</p>', { v: '<script>' }, { escape: true })).toBe(
      '<p>&lt;script&gt;</p>',
    );
  });

  it('substituted values containing braces are not re-interpolated', () => {
    expect(interpolate('{{a}}', { a: '{{b}}', b: 'nope' })).toBe('{{b}}');
  });
});

describe('renderTemplate', () => {
  const tpl = {
    subject: 'Alert: {{signal}} on {{resource}}',
    bodyText: '{{signal}} fired — {{detail}}',
    bodyHtml: '<h1>{{signal}}</h1><p>{{detail}}</p>',
  };

  it('interpolates subject and both bodies', () => {
    const r = renderTemplate(tpl, { signal: 'node-offline', resource: 'n1', detail: 'gone' });
    expect(r.subject).toBe('Alert: node-offline on n1');
    expect(r.bodyText).toBe('node-offline fired — gone');
    expect(r.bodyHtml).toBe('<h1>node-offline</h1><p>gone</p>');
  });

  it('html-escapes vars in bodyHtml but not bodyText or subject', () => {
    const r = renderTemplate(tpl, { signal: 'a<b', resource: 'r', detail: 'x&y' });
    expect(r.subject).toBe('Alert: a<b on r');
    expect(r.bodyText).toBe('a<b fired — x&y');
    expect(r.bodyHtml).toBe('<h1>a&lt;b</h1><p>x&amp;y</p>');
  });

  it('passes null bodies through', () => {
    const r = renderTemplate({ subject: 's', bodyText: null, bodyHtml: null }, { a: 'b' });
    expect(r.bodyText).toBeNull();
    expect(r.bodyHtml).toBeNull();
  });
});

describe('parseNotifyMeta — defensive Json decoding', () => {
  it('round-trips a full meta bag', () => {
    const meta = {
      bodyText: 't',
      bodyHtml: '<p>h</p>',
      template: 'alert-fired',
      attempts: 2,
      nextAttemptAt: '2026-07-02T00:00:00.000Z',
    };
    expect(parseNotifyMeta(meta)).toEqual(meta);
  });

  it('defaults every field on junk input', () => {
    for (const junk of [null, undefined, 'x', 42, [], { attempts: 'NaN' }]) {
      expect(parseNotifyMeta(junk)).toEqual({
        bodyText: null,
        bodyHtml: null,
        template: null,
        attempts: 0,
        nextAttemptAt: null,
      });
    }
  });
});
