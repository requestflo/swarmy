import * as React from 'react';
import { CopyButton, cn } from '@swarmy/ui';
import type { PlanRow } from './plan-records';

/**
 * "Create exactly this": type · name · value (+ which edge it is) · Copy.
 * The table scrolls inside its own box on a phone; the page never does.
 */
export function RecordTable({ rows, className }: { rows: PlanRow[]; className?: string }): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className={cn('border-border relative overflow-x-auto rounded-[12px] border', className)}>
      <table className="w-full min-w-[520px] text-left text-[13px]">
        <thead className="text-muted-foreground border-border border-b font-mono text-[11px] tracking-[0.06em] uppercase">
          <tr>
            <th scope="col" className="w-20 px-4 py-2.5 font-medium">Type</th>
            <th scope="col" className="w-24 px-2 py-2.5 font-medium">Name</th>
            <th scope="col" className="px-2 py-2.5 font-medium">Value</th>
            <th scope="col" className="w-24 px-4 py-2.5"><span className="sr-only">Copy</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.type}-${r.label}-${r.value}`} className="border-border border-b last:border-b-0">
              <td className="px-4 py-2.5 font-mono text-[12.5px] font-bold">{r.type}</td>
              <td className="px-2 py-2.5 font-mono text-[12.5px]">{r.label}</td>
              <td className="px-2 py-2.5 font-mono text-[12.5px]">
                <span className="break-all">{r.value}</span>
                {r.note ? <span className="text-muted-foreground ml-2 text-[11.5px]">{r.note}</span> : null}
              </td>
              <td className="px-4 py-2 text-right">
                <CopyButton value={r.value} label="Copy" className="pointer-coarse:min-h-11" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
