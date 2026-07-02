import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ScanDetailDrawerProps {
  scanId: string | null;
  onClose: () => void;
}

function severityClass(severity: string): string {
  if (severity === 'CRITICAL') return 'text-status-offline';
  if (severity === 'HIGH') return 'text-status-warning';
  return 'text-muted-foreground';
}

/** Right-side drawer with a scan's top CVEs + a rescan action. */
export function ScanDetailDrawer({ scanId, onClose }: ScanDetailDrawerProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const detail = useQuery({
    ...trpc.registryPolicy.scanDetail.queryOptions({ id: scanId ?? '' }),
    enabled: scanId !== null,
  });
  const rescan = useMutation(
    trpc.registryPolicy.rescan.mutationOptions({
      onSuccess: () => {
        toast.success('Rescan finished');
        qc.invalidateQueries({ queryKey: trpc.registryPolicy.listScans.queryKey() });
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const d = detail.data;

  return (
    <Sheet open={scanId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="mono-data break-all text-base">
            {d?.imageRef ?? 'Scan detail'}
          </SheetTitle>
          <SheetDescription>
            {d
              ? `${d.scanner} · ${new Date(d.scannedAt).toLocaleString()}${
                  d.digest ? ` · ${d.digest.replace('sha256:', '').slice(0, 12)}` : ''
                }`
              : 'Loading scan…'}
          </SheetDescription>
        </SheetHeader>

        <div className="grid gap-4 px-6 pb-6">
          {detail.isPending && scanId !== null ? (
            <div className="grid gap-2">
              <div className="shimmer-line h-5 w-full" />
              <div className="shimmer-line h-5 w-3/4" />
            </div>
          ) : detail.isError ? (
            <p className="text-status-offline text-sm">{detail.error.message}</p>
          ) : d ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="mono-data text-status-offline">
                  {d.criticalCount} critical
                </Badge>
                <Badge variant="outline" className="mono-data text-status-warning">
                  {d.highCount} high
                </Badge>
                <Badge variant="outline" className="mono-data">
                  {d.mediumCount} medium
                </Badge>
                <Badge variant="outline" className="mono-data">
                  {d.lowCount} low
                </Badge>
              </div>

              {d.error ? (
                <p className="text-status-offline bg-accent/40 rounded-xl px-4 py-3 text-sm">
                  Scan failed: {d.error}
                </p>
              ) : d.cves.length === 0 ? (
                <p className="text-status-online text-sm font-medium">
                  Clean — no vulnerabilities found.
                </p>
              ) : (
                <div className="divide-border grid divide-y rounded-xl border">
                  {d.cves.map((c) => (
                    <div key={`${c.id}-${c.pkgName}`} className="grid gap-0.5 px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="mono-data font-medium">{c.id}</span>
                        <span className={`mono-label ${severityClass(c.severity)}`}>{c.severity}</span>
                      </div>
                      <p className="text-muted-foreground truncate text-xs">{c.title ?? c.pkgName}</p>
                      <p className="mono-data text-muted-foreground text-xs">
                        {c.pkgName} {c.installedVersion}
                        {c.fixedVersion ? ` → fixed in ${c.fixedVersion}` : ' · no fix yet'}
                      </p>
                    </div>
                  ))}
                  {d.totalCves > d.cves.length && (
                    <p className="text-muted-foreground px-4 py-3 text-xs">
                      +{d.totalCves - d.cves.length} more lower-severity findings not shown.
                    </p>
                  )}
                </div>
              )}

              <Button
                variant="outline"
                disabled={rescan.isPending}
                onClick={() => rescan.mutate({ imageRef: d.imageRef })}
              >
                {rescan.isPending ? 'Rescanning…' : 'Rescan image'}
              </Button>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
