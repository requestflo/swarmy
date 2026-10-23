/**
 * "What the recorder sees": an example checkout form put through the same
 * rules the recorder runs with (packages/rum/src/client/replay.ts + rum.ts).
 * The form is a fixed example; the rules are this app's settings.
 */
import type { RumSettings } from './rum-shared';

/** replay.ts `MASK_TEXT` — text inside these is always masked. */
export const MASK_TEXT = '[data-swarmy-mask],.swarmy-mask,[data-sensitive],[data-private]';
/** rum.ts + replay.ts — always blocked, whatever the settings. */
export const ALWAYS_BLOCK = ['[data-swarmy-block]', '.swarmy-block', 'iframe', '[data-private] input'];

export type FieldState = 'clear' | 'masked' | 'blocked';
export interface PreviewField {
  key: string;
  kind: 'title' | 'input' | 'text' | 'frame' | 'button';
  label: string;
  value: string;
  state: FieldState;
}

interface Spec {
  key: string;
  kind: PreviewField['kind'];
  label: string;
  value: string;
  /** Builds the element (inside its wrapper, if any) and returns the leaf. */
  make: (doc: Document) => { wrap?: HTMLElement; leaf: HTMLElement };
}

const el = (doc: Document, tag: string, attrs: Record<string, string> = {}): HTMLElement => {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

const SPECS: Spec[] = [
  { key: 'title', kind: 'title', label: '', value: 'Checkout', make: (d) => ({ leaf: el(d, 'h3') }) },
  { key: 'email', kind: 'input', label: 'Email', value: 'maria.lopez@example.com', make: (d) => ({ leaf: el(d, 'input', { type: 'email' }) }) },
  { key: 'name', kind: 'input', label: 'Name', value: 'Maria Lopez', make: (d) => ({ leaf: el(d, 'input', { type: 'text' }) }) },
  { key: 'address', kind: 'text', label: 'Ships to · data-sensitive', value: '12 Bridge St, London', make: (d) => ({ leaf: el(d, 'p', { 'data-sensitive': '' }) }) },
  {
    key: 'card',
    kind: 'input',
    label: 'Card number · .card-number',
    value: '4242 4242 4242 4242',
    make: (d) => {
      const wrap = el(d, 'div', { class: 'card-number' });
      return { wrap, leaf: el(d, 'input', { inputmode: 'numeric' }) };
    },
  },
  { key: 'wallet', kind: 'frame', label: 'Payment frame · iframe', value: 'Apple Pay', make: (d) => ({ leaf: el(d, 'iframe') }) },
  { key: 'total', kind: 'text', label: '', value: 'Total £82.00', make: (d) => ({ leaf: el(d, 'span') }) },
  { key: 'pay', kind: 'button', label: '', value: 'Pay £82.00', make: (d) => ({ leaf: el(d, 'button') }) },
];

/** `closest` that treats a bad selector as matching nothing (and still tries the good ones). */
function closest(leaf: Element, selectors: string[]): boolean {
  try {
    return !!leaf.closest(selectors.join(','));
  } catch {
    return selectors.some((s) => {
      try {
        return !!leaf.closest(s);
      } catch {
        return false;
      }
    });
  }
}

/** Every field of the example form, with what the recorder does to it under these settings. */
export function recorderView(s: Pick<RumSettings, 'maskAllText' | 'blockSelectors'>, doc: Document): PreviewField[] {
  const form = el(doc, 'form');
  const block = [...ALWAYS_BLOCK, ...s.blockSelectors];
  return SPECS.map(({ make, ...f }) => {
    const { wrap, leaf } = make(doc);
    form.append(wrap ?? leaf);
    if (wrap) wrap.append(leaf);
    const state: FieldState = closest(leaf, block)
      ? 'blocked'
      : f.kind === 'input' || s.maskAllText || closest(leaf, [MASK_TEXT])
        ? 'masked'
        : 'clear';
    return { ...f, state };
  });
}

/**
 * rrweb's default masks, drawn with • where a replay shows *: an input
 * becomes one per character; masked text keeps its spaces.
 */
export function masked(f: Pick<PreviewField, 'kind' | 'value'>): string {
  return f.kind === 'input' ? '•'.repeat(f.value.length) : f.value.replace(/\S/g, '•');
}
