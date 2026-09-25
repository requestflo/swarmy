import * as React from 'react';
import { StatusWord } from '@/components/calm';
import { STEP_TEXT, usePlatformStatus, when } from './use-platform';

/** Every platform upgrade run, newest first (each is audited). */
export function RunHistory(): React.JSX.Element | null {
  const q = usePlatformStatus();
  const rows = q.data?.history ?? [];
  return (
    <section className="calm-card grid content-start gap-3 p-6" aria-label="Upgrade history">
      <h3 className="text-base font-semibold">History</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No upgrades yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground mono-label text-left">
              <tr>
                <th className="py-1.5 pr-4 font-normal">Started</th>
                <th className="py-1.5 pr-4 font-normal">Version</th>
                <th className="py-1.5 pr-4 font-normal">Trigger</th>
                <th className="py-1.5 pr-4 font-normal">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="mono-data py-2 pr-4 text-xs whitespace-nowrap">{when(r.startedAt)}</td>
                  <td className="mono-data py-2 pr-4 text-xs whitespace-nowrap">
                    {r.fromVersion} → {r.toVersion}
                  </td>
                  <td className="py-2 pr-4 text-xs">{r.trigger === 'auto' ? 'auto (window)' : 'manual'}</td>
                  <td className="py-2 pr-4 text-xs">
                    <StatusWord tone={r.status === 'done' ? 'ok' : r.status === 'running' ? 'info' : r.status === 'failed' ? 'bad' : 'idle'} word={r.status} />
                    {r.error ? (
                      <span className="text-muted-foreground ml-2">
                        at {STEP_TEXT[r.step]?.name ?? r.step}: {r.error}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
