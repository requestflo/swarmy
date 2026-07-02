import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  type StatusTone,
} from '@swarmy/ui';
import type { ImageScanView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { ScanDetailDrawer } from './scan-detail-drawer';

function scanTone(scan: ImageScanView): StatusTone {
  if (scan.status === 'error') return 'offline';
  if (scan.criticalCount > 0) return 'offline';
  if (scan.highCount > 0) return 'warning';
  return 'online';
}

function scanLabel(scan: ImageScanView): string {
  if (scan.status === 'error') return 'error';
  if (scan.criticalCount > 0) return 'critical';
  if (scan.highCount > 0) return 'attention';
  return 'clean';
}

function imageName(ref: string): string {
  const noDigest = ref.split('@')[0] ?? ref;
  const slash = noDigest.indexOf('/');
  return slash >= 0 ? noDigest.slice(slash + 1) : noDigest;
}

/** CVE scans of built images — flat rows in one card; click a row for detail. */
export function ScanList(): React.JSX.Element {
  const trpc = useTRPC();
  const scans = useQuery({
    ...trpc.registryPolicy.listScans.queryOptions({}),
    refetchInterval: 10_000,
  });
  const [openId, setOpenId] = React.useState<string | null>(null);
  const rows = scans.data ?? [];

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Image scans</CardTitle>
        <CardDescription>
          Trivy runs on every successful build. Click a scan to see the CVEs.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {scans.isPending ? (
          <div className="grid gap-2 px-6 pb-8">
            <div className="shimmer-line h-5 w-full" />
            <div className="shimmer-line h-5 w-2/3" />
          </div>
        ) : scans.isError ? (
          <p className="text-status-offline px-6 pb-8 text-sm">
            Couldn't load scans — {scans.error.message}
          </p>
        ) : rows.length === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<ShieldCheckIcon />}
              title="No scans yet"
              description="Push a build through CI and its image is scanned for CVEs automatically."
            />
          </div>
        ) : (
          <>
            <div className="hidden grid-cols-[2fr_1fr_1fr_1fr_auto] gap-x-4 px-6 pb-2 sm:grid">
              <span className="mono-label">Image</span>
              <span className="mono-label">Digest</span>
              <span className="mono-label">Crit / High / Med</span>
              <span className="mono-label">Scanned</span>
              <span className="mono-label text-right">Result</span>
            </div>
            <div className="divide-border divide-y border-t">
              {rows.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setOpenId(s.id)}
                  className="hover:bg-accent/60 grid w-full grid-cols-[1fr_auto] items-center gap-x-4 px-6 py-4 text-left transition-colors sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
                >
                  <div className="min-w-0">
                    <p className="mono-data truncate font-medium">{imageName(s.imageRef)}</p>
                    <p className="text-muted-foreground mono-label truncate sm:hidden">
                      {s.criticalCount} crit · {s.highCount} high
                    </p>
                  </div>
                  <span className="mono-data text-muted-foreground hidden truncate sm:block">
                    {s.digest ? s.digest.replace('sha256:', '').slice(0, 12) : '—'}
                  </span>
                  <span className="mono-data hidden sm:block">
                    <span className={s.criticalCount > 0 ? 'text-status-offline font-semibold' : ''}>
                      {s.criticalCount}
                    </span>
                    {' / '}
                    <span className={s.highCount > 0 ? 'text-status-warning' : ''}>{s.highCount}</span>
                    {' / '}
                    {s.mediumCount}
                  </span>
                  <span className="text-muted-foreground mono-label hidden truncate sm:block">
                    {new Date(s.scannedAt).toLocaleString()}
                  </span>
                  <div className="flex justify-end">
                    <StatusBadge tone={scanTone(s)} label={scanLabel(s)} />
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </CardContent>
      <ScanDetailDrawer scanId={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}
