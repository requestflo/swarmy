import * as React from 'react';
import type { ConfigIssue } from '@swarmy/app-config';
import { CompletePopup } from './complete-popup';
import { lineStarts, lineText, newlineFor, offsetToPos, posToOffset } from './editor-lines';
import type { Fix } from './fixes';
import { LintBubble } from './lint-bubble';
import { useAutocomplete } from './use-autocomplete';
import { CODE_LEFT, LINE_H, PAD_Y, YamlLines, type LineMark } from './yaml-lines';

interface YamlEditorProps {
  value: string;
  onChange: (next: string) => void;
  issues: readonly ConfigIssue[];
  marks: ReadonlyMap<number, LineMark>;
  /** Move the cursor to a line, or apply a fix there (bump `seq` to ask again). */
  request: EditorRequest | null;
  fixOf: (issue: ConfigIssue) => Fix | null;
}

export interface EditorRequest {
  seq: number;
  line: number;
  fix?: Fix;
}

/**
 * A lightweight swarmy.yaml editor: a transparent textarea over numbered,
 * coloured lines (no editor dependency). Enter keeps the indent (one step
 * deeper after `key:`), schema autocomplete opens as you type, and the
 * problem on the cursor's line sits beside it. Picks and fixes go through
 * `insertText`, so ⌘Z undoes them like typing.
 */
export function YamlEditor({ value, onChange, issues, marks, request, fixOf }: YamlEditorProps): React.JSX.Element {
  const ta = React.useRef<HTMLTextAreaElement>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = React.useState(0);
  const listId = React.useId();

  const insert = React.useCallback(
    (from: number, to: number, text: string) => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(from, to);
      if (!document.execCommand?.('insertText', false, text)) {
        onChange(el.value.slice(0, from) + text + el.value.slice(to));
        requestAnimationFrame(() => el.setSelectionRange(from + text.length, from + text.length));
      }
    },
    [onChange],
  );
  const ac = useAutocomplete(insert);

  const starts = React.useMemo(() => lineStarts(value), [value]);
  const cursorLine = offsetToPos(starts, cursor).line;
  const widest = React.useMemo(() => Math.max(40, ...value.split('\n').map((l) => l.length)), [value]);
  const shown = issues.find((i) => i.line === cursorLine) ?? issues.find((i) => i.severity === 'error' && i.line);

  /** Rewrite one line through insertText (undoable), leaving the cursor at its end. */
  const applyFix = React.useCallback(
    (fix: Fix) => {
      const el = ta.current;
      if (!el) return;
      const s = lineStarts(el.value);
      const from = s[fix.line - 1];
      if (from === undefined) return;
      const next = fix.apply(el.value).split('\n')[fix.line - 1] ?? '';
      insert(from, from + lineText(el.value, s, fix.line).length, next);
    },
    [insert],
  );

  React.useEffect(() => {
    const el = ta.current;
    if (!request || !el) return;
    const sc = scroller.current;
    if (sc) sc.scrollTop = Math.max(0, (request.line - 1) * LINE_H - sc.clientHeight / 3);
    if (request.fix) return applyFix(request.fix);
    const off = posToOffset(lineStarts(el.value), request.line);
    el.focus({ preventScroll: true });
    el.setSelectionRange(off, off);
    setCursor(off);
  }, [request, applyFix]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (ac.onKeyDown(e)) return;
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const el = e.currentTarget;
    const s = el.selectionStart;
    insert(s, el.selectionEnd, newlineFor(el.value.slice(el.value.lastIndexOf('\n', s - 1) + 1, s)));
  };

  return (
    <div ref={scroller} className="calm-code focus-within:ring-ring/60 relative h-[min(68vh,640px)] min-h-[320px] overflow-auto focus-within:ring-2">
      <div className="relative min-w-full" style={{ width: `calc(${CODE_LEFT + 24}px + ${widest + 2}ch)`, height: (starts.length + 1) * LINE_H + PAD_Y * 2 }}>
        <YamlLines text={value} marks={marks} cursorLine={cursorLine} />
        <textarea
          ref={ta}
          value={value}
          aria-label="swarmy.yaml"
          aria-multiline
          aria-autocomplete="list"
          aria-expanded={Boolean(ac.state)}
          aria-controls={ac.state ? listId : undefined}
          aria-activedescendant={ac.state ? `${listId}-${ac.state.active}` : undefined}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          onChange={(e) => {
            onChange(e.target.value);
            setCursor(e.target.selectionStart);
            ac.refresh(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
          onBlur={ac.close}
          onScroll={(e) => {
            // The wrapper scrolls, never the textarea: keep it pinned over the lines.
            e.currentTarget.scrollTop = 0;
            e.currentTarget.scrollLeft = 0;
          }}
          className="caret-primary selection:bg-primary/30 absolute inset-0 resize-none overflow-hidden bg-transparent whitespace-pre text-transparent outline-none selection:text-transparent"
          style={{ padding: `${PAD_Y}px 16px ${PAD_Y}px ${CODE_LEFT}px`, lineHeight: `${LINE_H}px` }}
        />
        {ac.state ? (
          <CompletePopup id={listId} state={ac.state} onPick={(c) => ac.accept(c)} onHover={ac.setActive} />
        ) : shown ? (
          <LintBubble issue={shown} lineLength={lineText(value, starts, shown.line ?? 1).length} fix={fixOf(shown)} onFix={applyFix} />
        ) : null}
      </div>
    </div>
  );
}
