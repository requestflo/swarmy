import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ScanRow } from './scan-row';

/** CVE scans of built images — flat rows in one card; click a row to expand detail inline. */
export function ScanList(): React.JSX.Element {
  const trpc = useTRPC();
  const scans = useQuery({
    ...trpc.registryPolicy.listScans.queryOptions({}),
    refetchInterval: 10_000,
  });
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
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
                <ScanRow
                  key={s.id}
                  scan={s}
                  expanded={expandedId === s.id}
                  onToggle={() => setExpandedId((cur) => (cur === s.id ? null : s.id))}
                />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
