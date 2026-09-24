import * as React from 'react';
import { PlayIcon } from 'lucide-react';
import { Button, Textarea, cn } from '@swarmy/ui';
import { StudioResult } from './studio-result';
import { StudioHistory } from './studio-history';
import { StudioSaveQuery } from './studio-save-query';
import { CLASS_TONE, verdictFor } from './studio-verdict';
import { useStudioRun } from './use-studio-run';
import { isKvEngine, isSqlEngine, type StudioScope } from './studio-types';

const PLACEHOLDER: Record<string, string> = {
  sql: 'SELECT * FROM users ORDER BY created_at DESC LIMIT 20',
  mongo: 'db.users.find({ plan: "pro" }).sort({ createdAt: -1 }).limit(20)',
  kv: 'HGETALL session:7f2a91c4',
};

/** The console: one statement at a time, live verdict, ⌘↵ to run, history + save. */
export function StudioConsole({ scope, draft, onDraft }: { scope: StudioScope; draft: string; onDraft: (s: string) => void }): React.JSX.Element {
  const { run, dialog, result, running, error } = useStudioRun(scope);
  const engine = scope.target.engine;
  const verdict = draft.trim() ? verdictFor(engine, draft) : null;
  const kind = isSqlEngine(engine) ? 'sql' : isKvEngine(engine) ? 'kv' : 'mongo';
  const label = kind === 'sql' ? `SQL console · ${engine}` : kind === 'kv' ? `Command console · ${engine}` : 'Mongo console · shell syntax or a {command}';
  const go = () => draft.trim() && run(draft, 'console');

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono-label text-muted-foreground">{label}</span>
        <div className="flex-1" />
        {verdict ? (
          <span className={cn('rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold', verdict.classification.blocked ? CLASS_TONE.destructive : CLASS_TONE[verdict.classification.class])}>
            {verdict.classification.blocked ? 'blocked' : `${verdict.classification.class} · ${verdict.action}`}
          </span>
        ) : null}
        <span className="bg-muted rounded-full px-2 py-0.5 font-mono text-[11px]">{kind === 'sql' ? 'read-only transaction' : 'read allowlist'}</span>
        <span className="bg-muted rounded-full px-2 py-0.5 font-mono text-[11px]">limit 1000 · timeout 15 s</span>
        <Button size="sm" onClick={go} disabled={running || !draft.trim()}>
          <PlayIcon className="size-3.5" /> {running ? 'Running…' : 'Run'} <span className="opacity-70">⌘↵</span>
        </Button>
      </div>
      <Textarea
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            go();
          }
        }}
        spellCheck={false}
        placeholder={PLACEHOLDER[kind]}
        className="bg-muted/40 min-h-32 font-mono text-[13px]"
        aria-label="Statement"
      />
      {verdict?.classification.blocked ? <p className="text-status-offline text-sm">{verdict.classification.blocked}</p> : null}
      {verdict && !verdict.classification.blocked && verdict.classification.reasons.length > 0 ? (
        <p className="text-muted-foreground text-xs">{verdict.classification.reasons.join(' · ')}</p>
      ) : null}
      <StudioSaveQuery scope={scope} statement={draft} />
      {error ? <p className="text-status-offline font-mono text-sm whitespace-pre-wrap">{error}</p> : null}
      {result ? <StudioResult result={result} name={scope.target.name} /> : null}
      <StudioHistory scope={scope} onPick={onDraft} refreshKey={result} />
      {dialog}
    </div>
  );
}
