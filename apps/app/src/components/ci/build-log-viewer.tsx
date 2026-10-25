import * as React from 'react';
import { cn } from '@swarmy/ui';
import { isWarningLine, lineTone, type LogLineView } from './build-log-parse';
import { BuildLogToolbar } from './build-log-toolbar';

const TONE_CLASS = { bad: 'text-tone-bad', warn: 'text-tone-warn', plain: '' } as const;

/**
 * The build log, line by line: Follow keeps the newest line in view (scrolling
 * up lets go, Follow catches up again), Only warnings narrows to warnings and
 * errors, Copy takes what's shown. `scope` names the stage the page narrowed
 * the lines to (the rail's pick), if any.
 */
export function BuildLogViewer({ lines, live, scope }: { lines: LogLineView[]; live: boolean; scope?: string | null }): React.JSX.Element {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [follow, setFollow] = React.useState(true);
  const [warningsOnly, setWarningsOnly] = React.useState(false);
  const shown = React.useMemo(() => (warningsOnly ? lines.filter((l) => isWarningLine(l.text)) : lines), [lines, warningsOnly]);

  React.useEffect(() => {
    const box = boxRef.current;
    if (box && follow) box.scrollTop = box.scrollHeight;
  }, [shown, follow]);

  const onScroll = (): void => {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const meta = [
    scope ? `${scope} only` : null,
    warningsOnly ? `warnings only · ${shown.length}` : `${lines.length} line${lines.length === 1 ? '' : 's'}`,
    !warningsOnly && follow && live ? 'following' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="grid gap-3">
      <BuildLogToolbar
        follow={follow}
        onFollow={setFollow}
        warningsOnly={warningsOnly}
        onWarningsOnly={setWarningsOnly}
        text={shown.map((l) => l.text).join('\n')}
        meta={meta}
      />
      <div
        ref={boxRef}
        onScroll={onScroll}
        // `dark` scopes the dark tokens to the panel, so the tone colours read on the code ground in both themes.
        className="calm-code dark h-[60vh] overflow-auto p-4 text-xs leading-relaxed"
      >
        {shown.length === 0 ? (
          <p className="opacity-70">
            {warningsOnly ? 'No warnings.' : scope ? `Nothing logged in ${scope.toLowerCase()} yet.` : live ? 'Waiting for build output…' : 'No logs captured.'}
          </p>
        ) : (
          shown.map((l) => (
            <pre
              key={l.key}
              className={cn('whitespace-pre-wrap', TONE_CLASS[lineTone(l.text) ?? 'plain'])}
            >
              {l.text}
            </pre>
          ))
        )}
      </div>
    </div>
  );
}
