import * as React from 'react';
import { CopyButton, StatusBadge, type StatusTone } from '@swarmy/ui';
import type { EmailRecordData } from './use-email';

const TONE: Record<EmailRecordData['status'], { tone: StatusTone; label: string }> = {
  ok: { tone: 'online', label: 'In place' },
  missing: { tone: 'warning', label: 'Missing' },
  mismatch: { tone: 'offline', label: 'Needs a fix' },
  error: { tone: 'neutral', label: 'Lookup failed' },
};

const KIND: Record<EmailRecordData['kind'], string> = { dkim: 'DKIM', spf: 'SPF', dmarc: 'DMARC', helo: 'Mail host' };

/** The exact records to publish, with what DNS answers today. */
export function DnsRecordsTable({ records, checked }: { records: EmailRecordData[]; checked: boolean }): React.JSX.Element {
  return (
    <div className="border-border divide-border mt-4 divide-y rounded-xl border">
      {records.map((r) => {
        const st = checked ? TONE[r.status] : { tone: 'neutral' as const, label: 'Not checked' };
        return (
          <div key={`${r.kind}-${r.name}-${r.value}`} className="grid gap-2 px-4 py-3 md:grid-cols-[7rem_1fr_9rem]">
            <div>
              <p className="text-sm font-semibold">
                {KIND[r.kind]} {r.required ? <span className="text-primary text-xs">required</span> : null}
              </p>
              <p className="mono-label text-muted-foreground">{r.type}</p>
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-1">
                <code className="mono-data truncate text-xs">{r.name}</code>
                <CopyButton value={r.name} />
              </div>
              <div className="bg-muted/50 flex items-start gap-1 rounded-md px-2 py-1">
                <code className="mono-data text-xs break-all">{r.value}</code>
                <CopyButton value={r.value} />
              </div>
              <p className="text-muted-foreground text-xs">{r.hint ?? r.purpose}</p>
              {checked && r.status !== 'ok' && r.found.length ? (
                <p className="text-muted-foreground mono-data text-xs break-all">DNS answers: {r.found.join(' | ')}</p>
              ) : null}
            </div>
            <div className="md:text-right">
              <StatusBadge tone={st.tone} label={st.label} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
