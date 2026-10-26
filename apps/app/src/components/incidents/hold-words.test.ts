import { describe, expect, it } from 'bun:test';
import { clockWords } from '@/components/apps/app-board-words';
import { firstName, holdWords, KEEP_LABEL, TAKE_LABEL } from './hold-words';

const until = '2026-10-25T14:32:00.000Z';

describe('holdWords', () => {
  it('names the owner by first name, or says it is yours', () => {
    expect(holdWords({ name: 'Sam Okafor', until, mine: false })).toBe(`Sam has this until ${clockWords(until)}.`);
    expect(holdWords({ name: 'Sam Okafor', until, mine: true })).toBe(`You have this until ${clockWords(until)}.`);
  });

  it('is null when nobody has it', () => {
    expect(holdWords(null)).toBeNull();
  });
});

describe('firstName', () => {
  it('keeps an address whole', () => {
    expect(firstName('sam@northwind.dev')).toBe('sam@northwind.dev');
    expect(firstName('Calum')).toBe('Calum');
  });
});

it('the buttons say 30 minutes', () => {
  expect(TAKE_LABEL).toBe('Take it for 30 min');
  expect(KEEP_LABEL).toBe('30 more min');
});
