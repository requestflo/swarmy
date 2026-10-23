import * as React from 'react';
import type { DotenvWarning } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { lineMarks, markOf } from './paste-model';

const MARK = { error: { sign: '✕', cls: 'text-tone-bad' }, warn: { sign: '!', cls: 'text-tone-warn' } } as const;

/**
 * The paste box: a numbered editor whose gutter marks the lines the parser
 * had something to say about, and the parser notes underneath.
 */
export function EnvLineEditor({
  text,
  onChange,
  warnings,
}: {
  text: string;
  onChange: (t: string) => void;
  warnings: DotenvWarning[];
}): React.JSX.Element {
  const gutter = React.useRef<HTMLDivElement>(null);
  const marks = lineMarks(warnings);
  const count = Math.max(1, text.split('\n').length);
  return (
    <section aria-label="Pasted text" className="flex min-w-0 flex-col gap-2">
      <div className="calm-code flex h-[22rem] overflow-hidden rounded-xl font-mono text-[12px] leading-5 lg:h-[26rem]">
        <div ref={gutter} aria-hidden className="w-12 shrink-0 overflow-hidden py-2 text-right select-none">
          {Array.from({ length: count }, (_, i) => {
            const m = marks.get(i + 1);
            return (
              <div key={i} className="flex h-5 items-center justify-end gap-1 pr-1.5 opacity-80">
                <span className="text-muted-foreground">{i + 1}</span>
                <span className={cn('w-2.5 text-center font-bold', m ? MARK[m].cls : '')}>{m ? MARK[m].sign : ''}</span>
              </div>
            );
          })}
        </div>
        <textarea
          aria-label="Paste a .env"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          wrap="off"
          spellCheck={false}
          autoFocus
          placeholder={'DATABASE_URL=postgres://…\nexport API_KEY="…"'}
          className="placeholder:text-muted-foreground/60 min-w-0 flex-1 resize-none bg-transparent py-2 pr-3 leading-5 outline-none"
        />
      </div>
      <div className="calm-card flex flex-col gap-1.5 px-3 py-2.5">
        <span className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">Parser notes</span>
        {warnings.length === 0 ? (
          <span className="text-muted-foreground text-xs">{text.trim() ? 'Every line read cleanly.' : 'Paste a file to see what swarmy reads.'}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-baseline gap-2 text-xs">
                <span className={cn('shrink-0 font-mono font-semibold', MARK[markOf(w)].cls)}>line {w.line}</span>
                <span className="text-muted-foreground">{w.message}</span>
              </li>
            ))}
          </ul>
        )}
        <span className="text-muted-foreground font-mono text-[10.5px]">
          Handles comments, quotes, multi-line values and export. Duplicates: the last one wins.
        </span>
      </div>
    </section>
  );
}
