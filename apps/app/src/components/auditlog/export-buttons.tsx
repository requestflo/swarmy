import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { DownloadIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import type { AuditExportResult, AuditFilterInput } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

function download(result: AuditExportResult): void {
  const url = URL.createObjectURL(new Blob([result.content], { type: result.contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export the CURRENT filter as CSV (primary) or JSON — downloads in-browser. */
export function ExportButtons({ filters }: { filters: AuditFilterInput }): React.JSX.Element {
  const trpc = useTRPC();
  const exportLog = useMutation(
    trpc.audit.export.mutationOptions({
      onSuccess: (result) => {
        download(result);
        toast.success(
          `Exported ${result.rowCount.toLocaleString()} entr${result.rowCount === 1 ? 'y' : 'ies'}${
            result.truncated ? ' — capped at 10,000; narrow the date range for the rest' : ''
          }`,
        );
      },
      onError: (e) => toast.error(`Export failed — ${e.message}`),
    }),
  );

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        disabled={exportLog.isPending}
        onClick={() => exportLog.mutate({ ...filters, format: 'csv' })}
      >
        <DownloadIcon className="size-4" />
        {exportLog.isPending ? 'Exporting…' : 'Export CSV'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={exportLog.isPending}
        onClick={() => exportLog.mutate({ ...filters, format: 'json' })}
      >
        Export JSON
      </Button>
    </div>
  );
}
