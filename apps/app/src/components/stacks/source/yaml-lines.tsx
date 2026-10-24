import * as React from 'react';
import { cn } from '@swarmy/ui';
import { highlightLine, type TokenClass } from './yaml-highlight';

/** Editor metrics shared by the backdrop, the textarea and the popovers. */
export const LINE_H = 19;
export const PAD_Y = 10;
/** Line numbers (40px) + gutter dot (14px) + 8px before the code. */
export const CODE_LEFT = 62;

const TOKEN: Record<TokenClass, string> = {
  key: 'text-code-key',
  string: 'text-code-string',
  number: 'text-code-number',
  binding: 'text-code-binding',
  comment: 'text-code-comment',
  plain: '',
};

export interface LineMark {
  severity?: 'error' | 'warning';
  /** Added or changed since the saved file. */
  changed?: boolean;
}

/**
 * The editor's backdrop: numbered, coloured lines under the transparent
 * textarea. A problem puts a dot in the gutter (crimson error, amber
 * warning) and a wavy line under an error; a line edited since the saved
 * file gets a green dot and wash.
 */
export const YamlLines = React.memo(function YamlLines({
  text,
  marks,
  cursorLine,
}: {
  text: string;
  marks: ReadonlyMap<number, LineMark>;
  cursorLine: number;
}): React.JSX.Element {
  const lines = React.useMemo(() => text.split('\n'), [text]);
  return (
    <div aria-hidden className="pointer-events-none select-none" style={{ paddingTop: PAD_Y, paddingBottom: PAD_Y }}>
      {lines.map((line, i) => {
        const n = i + 1;
        const m = marks.get(n);
        const dot = m?.severity === 'error' ? 'bg-status-offline' : m?.severity === 'warning' ? 'bg-status-warning' : m?.changed ? 'bg-status-online' : '';
        return (
          <div
            key={i}
            className={cn('flex whitespace-pre', m?.changed ? 'bg-status-online/10' : n === cursorLine && 'bg-code-foreground/5')}
            style={{ height: LINE_H, lineHeight: `${LINE_H}px` }}
          >
            <span className={cn('w-10 shrink-0 pr-2 text-right tabular-nums', n === cursorLine ? 'text-code-foreground' : 'text-code-comment')}>{n}</span>
            <span className="flex w-3.5 shrink-0 items-center justify-center">{dot ? <i className={cn('size-1.5 rounded-full', dot)} /> : null}</span>
            <span className={cn('pl-2', m?.severity === 'error' && 'decoration-status-offline underline decoration-wavy underline-offset-[3px]')}>
              {highlightLine(line).map((t, k) => (
                <span key={k} className={TOKEN[t.cls]}>
                  {t.text}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
});
