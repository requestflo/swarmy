import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2Icon, XIcon } from 'lucide-react';
import { Button, Input } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import { StudioResultTable } from './studio-result-table';
import { useStudioEdit } from './use-studio-edit';
import { cellText, type StudioKeyRow, type StudioScope } from './studio-types';

const FIELD_LABEL: Record<string, string | null> = { hash: 'field', zset: 'score', list: 'index (blank = append)', string: null, set: null, stream: null };

/** One key: its value (capped), set / add / remove, delete the key. Every change shows the exact command first. */
export function StudioKeyValue({ scope, row, onClose, onChanged }: { scope: StudioScope; row: StudioKeyRow; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery(trpc.studio.keyValue.queryOptions({ stack: scope.stack, target: scope.target.name, dbIndex: scope.dbIndex, key: row.key, type: row.type }));
  const { edit, dialog, busy } = useStudioEdit(scope, () => { void q.refetch(); onChanged(); });
  const [field, setField] = React.useState('');
  const [value, setValue] = React.useState('');
  const fieldLabel = FIELD_LABEL[row.type] ?? null;
  React.useEffect(() => {
    setField('');
    setValue(row.type === 'string' && q.data ? cellText(q.data.rows[0]?.[0] ?? '') : '');
  }, [row.key, row.type, q.data]);
  const member = (i: number): string | null => {
    const r = q.data?.rows[i];
    if (!r) return null;
    return row.type === 'stream' || row.type === 'hash' || row.type === 'zset' || row.type === 'set' ? cellText(r[0]) : null;
  };

  return (
    <aside className="border-border bg-card flex w-full shrink-0 flex-col gap-3 border-l p-4 lg:w-96" aria-label="Key">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="mono-label text-muted-foreground">{row.type}</p>
          <p className="truncate font-mono text-sm font-semibold">{row.key}</p>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}><XIcon className="size-4" /></Button>
      </div>
      {q.isPending ? <CardSkeleton /> : q.isError ? <ErrorState error={q.error} /> : row.type !== 'string' ? (
        <StudioResultTable
          columns={q.data.columns}
          rows={q.data.rows}
          className="max-h-72"
          onSelect={row.type === 'list' ? undefined : (i) => {
            const m = member(i);
            if (m != null) edit({ kind: 'redisRemove', type: row.type, key: row.key, member: m });
          }}
        />
      ) : null}
      {row.type !== 'list' && row.type !== 'string' ? <p className="text-muted-foreground text-[11px]">Click a row to remove it.</p> : null}
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); edit({ kind: 'redisSet', type: row.type, key: row.key, field: fieldLabel ? (field || null) : null, value }); }}>
        {fieldLabel ? <Input value={field} onChange={(e) => setField(e.target.value)} placeholder={fieldLabel} className="h-8 font-mono text-xs" /> : null}
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" className="h-8 font-mono text-xs" />
        <Button size="sm" type="submit" className="w-full" disabled={busy || row.type === 'stream'}>
          {row.type === 'string' ? 'Set value (keeps TTL)' : `Add / set ${fieldLabel ?? 'member'}`}
        </Button>
      </form>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => edit({ kind: 'redisRemove', type: row.type, key: row.key, member: null })}>
        <Trash2Icon className="size-3.5" /> Delete key
      </Button>
      {dialog}
    </aside>
  );
}
