import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import type { ImageScanView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { Section, TONE_DOT, TONE_TEXT, Tech, type Tone } from '@/components/calm';
import { relTime } from '@/lib/format';

function verdict(s: ImageScanView): { tone: Tone; say: string } {
  if (s.status === 'error') return { tone: 'bad', say: 'The vulnerability scan couldn’t finish.' };
  if (s.criticalCount > 0) return { tone: 'bad', say: `${s.criticalCount} critical and ${s.highCount} high vulnerabilities.` };
  if (s.highCount > 0) return { tone: 'warn', say: `No critical vulnerabilities; ${s.highCount} high.` };
  return { tone: 'ok', say: 'No critical or high vulnerabilities.' };
}

/**
 * The pushed image (only once BuildKit returned its digest) and the CVE scan of
 * that exact digest — swarmy deploys the digest, so the scan is of what runs.
 */
export function BuildImageCard({ image }: { image: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const at = image.indexOf('@sha256:');
  const digest = at >= 0 ? image.slice(at + 1) : null;
  const scans = useQuery({ ...trpc.registryPolicy.listScans.queryOptions({ limit: 200 }), enabled: !!digest });
  if (!digest) return null;
  const scan = scans.data?.find((s) => s.digest === digest);
  const v = scan ? verdict(scan) : null;
  return (
    <Section title="Image">
      <div className="grid gap-2 text-sm">
        <p className="font-mono text-[12px] break-all">{image}</p>
        <p className="text-muted-foreground">Deployed by digest, never by tag.</p>
        {scan && v ? (
          <div className="grid gap-0.5">
            <p className="flex items-center gap-2">
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[v.tone])} />
              <span className={TONE_TEXT[v.tone]}>{v.say}</span>
            </p>
            <Tech className="pl-4">
              {scan.scanner} · {scan.criticalCount} critical · {scan.highCount} high · {scan.mediumCount} medium ·{' '}
              {scan.lowCount} low · scanned {relTime(scan.scannedAt)}
            </Tech>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
