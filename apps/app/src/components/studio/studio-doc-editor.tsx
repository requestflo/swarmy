import * as React from 'react';
import { Trash2Icon, XIcon } from 'lucide-react';
import { parseRelaxedJson } from '@swarmy/core/studio';
import { Button, Textarea, cn } from '@swarmy/ui';
import { useStudioEdit } from './use-studio-edit';
import type { StudioRunView, StudioScope } from './studio-types';

interface StudioDocEditorProps {
  scope: StudioScope;
  collection: string;
  /** The document; null ⇒ inserting. */
  doc: Record<string, unknown> | null;
  onClose: () => void;
  onApplied: (r: StudioRunView) => void;
}

/** Edit a document as JSON; Save becomes `$set` / `$unset` of the changed top-level fields by `_id`. */
export function StudioDocEditor({ scope, collection, doc, onClose, onApplied }: StudioDocEditorProps): React.JSX.Element {
  const start = React.useMemo(() => JSON.stringify(doc ?? {}, null, 2), [doc]);
  const [text, setText] = React.useState(start);
  React.useEffect(() => setText(start), [start]);
  const { edit, dialog, busy } = useStudioEdit(scope, onApplied);
  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    const v = parseRelaxedJson(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('a document must be an object');
    parsed = v as Record<string, unknown>;
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }
  const changed = parsed && doc ? Object.keys(parsed).filter((k) => k !== '_id' && JSON.stringify(parsed![k]) !== JSON.stringify(doc[k])) : [];
  const removed = parsed && doc ? Object.keys(doc).filter((k) => k !== '_id' && !(k in parsed!)) : [];
  const dirty = doc ? changed.length + removed.length > 0 : Boolean(parsed && Object.keys(parsed).length);

  const save = () => {
    if (!parsed) return;
    if (!doc) return edit({ kind: 'mongoInsert', collection, doc: parsed });
    edit({ kind: 'mongoUpdate', collection, id: doc._id, set: Object.fromEntries(changed.map((k) => [k, parsed![k]])), unset: removed });
  };

  return (
    <aside className="border-border bg-card flex w-full shrink-0 flex-col gap-3 border-l p-4 lg:w-96" aria-label="Document editor">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="mono-label text-muted-foreground">{doc ? 'Document' : 'New document'}</p>
          <p className="truncate font-mono text-sm font-semibold">{collection}</p>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}><XIcon className="size-4" /></Button>
      </div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className={cn('min-h-72 flex-1 font-mono text-xs', parseError && 'border-status-offline')} />
      {parseError ? <p className="text-status-offline font-mono text-xs">{parseError}</p> : null}
      {doc && dirty ? (
        <p className="text-muted-foreground font-mono text-[11px]">
          {changed.length ? `$set ${changed.join(', ')}` : ''} {removed.length ? `$unset ${removed.join(', ')}` : ''}
        </p>
      ) : null}
      <p className={cn('text-xs', scope.unlocked ? 'text-muted-foreground' : 'text-status-warning')}>
        {scope.unlocked ? 'Save shows the exact command, then runs it and writes an audit row.' : 'Read-only. Unlock writes above — needs data.write.'}
      </p>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" disabled={!dirty || Boolean(parseError) || busy} onClick={save}>
          {doc ? 'Save' : 'Insert document'}
        </Button>
        {doc ? (
          <Button size="sm" variant="destructive" aria-label="Delete document" disabled={busy} onClick={() => edit({ kind: 'mongoDelete', collection, id: doc._id })}>
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {dialog}
    </aside>
  );
}
