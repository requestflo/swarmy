import * as React from 'react';
import { ChevronRightIcon, MapIcon } from 'lucide-react';
import { Badge, Switch, cn } from '@swarmy/ui';

export interface FrameView {
  filename: string;
  function: string | null;
  lineno: number | null;
  colno: number | null;
  inApp: boolean;
  module: string | null;
  preContext: string[];
  contextLine: string | null;
  postContext: string[];
  minified: { filename: string | null; function: string | null; lineno: number | null; colno: number | null } | null;
  sourcemap: string | null;
}

export interface ExceptionView {
  type: string;
  value: string;
  mechanism: string | null;
  handled: boolean | null;
  frames: FrameView[];
}

/**
 * Sentry-style stack trace: newest (crash) frame first, app frames
 * expanded with source context, library frames collapsed behind a toggle.
 * A source-mapped frame shows its original file/function and, on demand,
 * the minified position it came from.
 */
export function StackTrace({ exceptions }: { exceptions: ExceptionView[] }): React.JSX.Element {
  const [allFrames, setAllFrames] = React.useState(false);
  // Sentry order is cause-first; show the thrown exception on top.
  const ordered = [...exceptions].reverse();
  return (
    <div className="space-y-5">
      <label className="text-muted-foreground flex items-center justify-end gap-2 text-xs">
        Library frames <Switch checked={allFrames} onCheckedChange={setAllFrames} />
      </label>
      {ordered.map((e, i) => (
        <div key={i} className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            {i > 0 ? <span className="mono-label text-muted-foreground">caused by</span> : null}
            <span className="text-sm font-semibold">{e.type || 'Error'}</span>
            <span className="text-muted-foreground min-w-0 text-sm break-words">{e.value}</span>
            {e.handled === false ? <Badge variant="destructive">unhandled</Badge> : null}
            {e.mechanism ? <Badge variant="muted">{e.mechanism}</Badge> : null}
          </div>
          <Frames frames={e.frames} allFrames={allFrames} />
        </div>
      ))}
    </div>
  );
}

function Frames({ frames, allFrames }: { frames: FrameView[]; allFrames: boolean }): React.JSX.Element {
  const newestFirst = [...frames].reverse();
  const hasApp = newestFirst.some((f) => f.inApp);
  const shown = allFrames || !hasApp ? newestFirst : newestFirst.filter((f) => f.inApp);
  const hidden = newestFirst.length - shown.length;
  if (!newestFirst.length) return <p className="text-muted-foreground text-sm">No stack trace was sent.</p>;
  return (
    <div className="overflow-hidden rounded-xl border">
      {shown.map((f, i) => (
        <Frame key={i} frame={f} defaultOpen={i === 0 || (f.inApp && i < 3)} />
      ))}
      {hidden > 0 ? (
        <p className="text-muted-foreground bg-muted/40 border-t px-4 py-2 text-xs">{hidden} library frames hidden</p>
      ) : null}
    </div>
  );
}

function Frame({ frame: f, defaultOpen }: { frame: FrameView; defaultOpen: boolean }): React.JSX.Element {
  const hasContext = !!f.contextLine;
  const [open, setOpen] = React.useState(defaultOpen && hasContext);
  const [showMin, setShowMin] = React.useState(false);
  const line = f.lineno ?? 0;
  return (
    <div className={cn('border-b last:border-b-0', !f.inApp && 'bg-muted/30')}>
      <button
        type="button"
        onClick={() => hasContext && setOpen((o) => !o)}
        className={cn('flex w-full items-center gap-2 px-4 py-2 text-left', hasContext && 'hover:bg-accent/50')}
      >
        <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90', !hasContext && 'opacity-0')} />
        <span className="mono-data min-w-0 flex-1 truncate text-xs">
          <span className={cn(f.inApp ? 'font-semibold' : 'text-muted-foreground')}>{f.module || f.filename}</span>
          {f.function ? <span className="text-muted-foreground"> in </span> : null}
          {f.function ? <span className="font-semibold">{f.function}</span> : null}
          {f.lineno ? (
            <span className="text-muted-foreground">
              {' '}
              at line {f.lineno}
              {f.colno ? `:${f.colno}` : ''}
            </span>
          ) : null}
        </span>
        {f.sourcemap ? (
          <span
            role="button"
            tabIndex={0}
            title="Resolved with a source map — show the minified position"
            onClick={(e) => {
              e.stopPropagation();
              setShowMin((s) => !s);
            }}
            className="text-status-progress flex shrink-0 items-center gap-1 text-[11px]"
          >
            <MapIcon className="size-3" /> source-mapped
          </span>
        ) : null}
        {f.inApp ? <Badge variant="info" className="shrink-0">app</Badge> : null}
      </button>
      {showMin && f.minified ? (
        <p className="text-muted-foreground mono-data px-10 pb-2 text-[11px] break-all">
          minified: {f.minified.function ?? '?'} at {f.minified.filename}:{f.minified.lineno}:{f.minified.colno} · map {f.sourcemap}
        </p>
      ) : null}
      {open ? (
        <pre className="bg-ink text-ink-foreground overflow-x-auto py-2 text-xs leading-5">
          {f.preContext.map((l, i) => (
            <CodeLine key={`p${i}`} n={line - f.preContext.length + i} text={l} />
          ))}
          <CodeLine n={line} text={f.contextLine ?? ''} active />
          {f.postContext.map((l, i) => (
            <CodeLine key={`n${i}`} n={line + 1 + i} text={l} />
          ))}
        </pre>
      ) : null}
    </div>
  );
}

function CodeLine({ n, text, active }: { n: number; text: string; active?: boolean }): React.JSX.Element {
  return (
    <div className={cn('flex px-4', active && 'bg-status-offline/25')}>
      <span className="w-10 shrink-0 pr-3 text-right opacity-50 select-none">{n > 0 ? n : ''}</span>
      <span className="whitespace-pre">{text}</span>
    </div>
  );
}
