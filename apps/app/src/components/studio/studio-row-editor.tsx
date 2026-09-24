import * as React from 'react';
import { Trash2Icon, XIcon } from 'lucide-react';
import { Button, Input, cn } from '@swarmy/ui';
import { useStudioEdit } from './use-studio-edit';
import { cellText, type StudioRunView, type StudioScope, type StudioTableView } from './studio-types';

type Val = string | null;

interface StudioRowEditorProps {
  scope: StudioScope;
  table: StudioTableView;
  columns: string[];
  /** The row being edited; null ⇒ inserting a new row. */
  row: unknown[] | null;
  onClose: () => void;
  onApplied: (r: StudioRunView) => void;
}

/** Edit / insert / delete one SQL row. Changes show as a diff; Save shows the exact statement first. */
export function StudioRowEditor({ scope, table, columns, row, onClose, onApplied }: StudioRowEditorProps): React.JSX.Element {
  const original = React.useMemo<Record<string, Val>>(
    () => Object.fromEntries(columns.map((c, i) => [c, row ? (row[i] == null ? null : cellText(row[i])) : null])),
    [columns, row],
  );
  const [draft, setDraft] = React.useState<Record<string, Val>>(original);
  React.useEffect(() => setDraft(original), [original]);
  const { edit, dialog, busy } = useStudioEdit(scope, onApplied);
  const keys = table.keyColumns;
  const editable = keys.length > 0 && table.type === 'table';
  const changed = columns.filter((c) => (row ? draft[c] !== original[c] : draft[c] !== null && draft[c] !== ''));
  const key = Object.fromEntries(keys.map((k) => [k, original[k] ?? null]));
  const type = (c: string) => table.columns.find((x) => x.name === c)?.type ?? '';

  const save = () => {
    const values = Object.fromEntries(changed.map((c) => [c, draft[c] ?? null]));
    edit(row ? { kind: 'update', table: { schema: table.schema, name: table.name }, key, set: values } : { kind: 'insert', table: { schema: table.schema, name: table.name }, values });
  };

  return (
    <aside className="border-border bg-card flex w-full shrink-0 flex-col gap-3 overflow-auto border-l p-4 lg:w-80" aria-label="Row editor">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="mono-label text-muted-foreground">{row ? 'Row' : 'New row'}</p>
          <p className="truncate font-mono text-sm font-semibold">{row ? `${table.name} ${keys.map((k) => `#${original[k]}`).join(' ')}` : table.name}</p>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}><XIcon className="size-4" /></Button>
      </div>
      {columns.map((c) => {
        const isKey = keys.includes(c) && Boolean(row);
        const v = draft[c];
        const dirty = row ? v !== original[c] : false;
        return (
          <label key={c} className="border-border block space-y-1 border-b pb-2">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold">
              {c}
              <span className="text-muted-foreground font-mono text-[10px] font-normal">{type(c)}</span>
              <span className="flex-1" />
              {!isKey && editable ? (
                <button type="button" className={cn('font-mono text-[10px]', v === null ? 'text-primary' : 'text-muted-foreground')} onClick={() => setDraft({ ...draft, [c]: v === null ? '' : null })}>
                  NULL
                </button>
              ) : null}
            </span>
            <Input
              value={v ?? ''}
              placeholder={v === null ? (row ? 'NULL' : 'default') : ''}
              disabled={isKey || !editable}
              onChange={(e) => setDraft({ ...draft, [c]: e.target.value })}
              className={cn('h-8 font-mono text-xs', dirty && 'border-primary text-primary')}
            />
          </label>
        );
      })}
      {row && changed.length > 0 ? (
        <pre className="bg-muted rounded-md p-2 font-mono text-[11px] whitespace-pre-wrap">
          {changed.map((c) => `- ${c} = ${original[c] ?? 'NULL'}\n+ ${c} = ${draft[c] ?? 'NULL'}`).join('\n')}
        </pre>
      ) : null}
      <p className={cn('text-xs', scope.unlocked ? 'text-muted-foreground' : 'text-status-warning')}>
        {!editable
          ? 'No primary key or unique index — edit this table from the console.'
          : scope.unlocked
            ? 'Save shows the exact statement, then runs it through the agent and writes an audit row.'
            : 'Read-only. Unlock writes above — needs data.write.'}
      </p>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" disabled={!editable || changed.length === 0 || busy} onClick={save}>
          {row ? `Save${changed.length ? ` (${changed.length})` : ''}` : 'Insert row'}
        </Button>
        {row && editable ? (
          <Button size="sm" variant="destructive" disabled={busy} aria-label="Delete row" onClick={() => edit({ kind: 'delete', table: { schema: table.schema, name: table.name }, key })}>
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {dialog}
    </aside>
  );
}
