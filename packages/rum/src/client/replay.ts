/**
 * replay.js — the rrweb recorder, loaded by rum.js only for a sampled,
 * consented, identified session. rrweb is MIT (github.com/rrweb-io/rrweb),
 * pinned to @rrweb/record 2.1.6 in packages/rum/package.json.
 *
 * Privacy defaults are NOT optional: every input is masked (typed text is
 * never recorded), `[data-swarmy-mask]`, `.swarmy-mask`, `[data-sensitive]`
 * and `[data-private]` text is masked, `[data-swarmy-block]` / `.swarmy-block`
 * / `iframe` are blocked (drawn as a grey box). `data-mask="all"` masks every
 * text node too.
 */
import { record } from '@rrweb/record';

const MASK_TEXT = '[data-swarmy-mask],.swarmy-mask,[data-sensitive],[data-private]';

window.__swarmyRecord = (o) => {
  const stop = record({
    emit: o.emit,
    maskAllInputs: true,
    maskInputOptions: { password: true, email: true, tel: true, text: true, textarea: true, number: true, search: true },
    maskTextSelector: o.maskAllText ? '*' : MASK_TEXT,
    blockSelector: `${o.blockSelector},iframe,[data-private] input`,
    inlineStylesheet: true,
    collectFonts: false,
    recordCanvas: false,
    sampling: { mousemove: 50, scroll: 150, input: 'last', media: 800 },
    slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true, headMetaSocial: true, headMetaRobots: true, headMetaVerification: true },
    checkoutEveryNms: 5 * 60 * 1000,
  });
  return {
    stop: () => stop?.(),
    addCustom: (tag: string, payload: unknown) => record.addCustomEvent(tag, payload),
    takeSnapshot: () => record.takeFullSnapshot(true),
  };
};

export {};
