import * as React from 'react';
import { ArrowRightIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, Tech, type Tone } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { bytes, relTime } from '@/lib/format';
import type { AppPreview } from '../gitops-types';
import type { PreviewData } from './use-preview-data';

function Box({ title, lines, tone }: { title: string; lines: string[]; tone?: Tone }): React.JSX.Element {
  return (
    <div className={cn('border-border flex min-w-0 flex-1 flex-col gap-0.5 rounded-xl border px-3 py-2.5', tone === 'ok' && 'border-status-online/60', tone === 'bad' && 'border-status-offline/60')}>
      <span className="text-[13px] font-semibold">{title}</span>
      {lines.map((l) => (
        <span key={l} className="text-muted-foreground truncate font-mono text-[11px]">{l}</span>
      ))}
    </div>
  );
}

const Arrow = (): React.JSX.Element => <ArrowRightIcon aria-hidden className="text-muted-foreground size-4 shrink-0 rotate-90 self-center sm:rotate-0" />;

/**
 * Preview with data: the source database → its newest backup → the
 * preview's private copy, and the steps the copy went through (the restore
 * drill's clone path, then the scrub). Without data: its own empty database.
 */
export function PreviewDataFlow({ preview, d }: { preview: AppPreview; d: PreviewData }): React.JSX.Element {
  if (!d.ready) return <TextSkeleton className="h-16 w-full" />;
  if (!preview.data || !d.cluster) {
    return (
      <div className="flex flex-col gap-2">
        <Box title="Its own database" lines={[`${preview.stack} · throwaway`, 'migrations run, no customer data']} />
        <p className="text-muted-foreground text-xs">Starts empty — nobody’s real data ends up in a preview unless the rules say so.</p>
      </div>
    );
  }
  const tone: Tone = d.outcome?.status === 'done' ? 'ok' : d.outcome?.status === 'failed' ? 'bad' : 'info';
  const s = d.snapshot;
  const steps: Array<[string, string]> = [
    [`Pick the newest backup of ${d.fromStack}/${d.cluster}`, s ? `${relTime(s.time)}${s.sizeBytes ? ` · ${bytes(Number(s.sizeBytes))}` : ''}` : ''],
    [`Restore it into ${preview.stack}/${d.cluster}`, 'the restore drill’s clone path'],
    ...(preview.data.scrub ? ([[`Run ${preview.data.scrub} on the copy`, 'before the app sees it']] as Array<[string, string]>) : []),
    ['Destroyed with the preview', 'production is never touched'],
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Box title={`${preview.data.from} database`} lines={[`${d.fromStack}/${d.cluster}`, 'postgres']} />
        <Arrow />
        <Box title="Backup" lines={s === undefined ? ['reading…'] : s ? [relTime(s.time), `${s.sizeBytes ? bytes(Number(s.sizeBytes)) : 'size unknown'} · ${s.engine ?? 'dump'}`] : ['none yet — the copy step fails until one exists']} />
        <Arrow />
        <Box title={`${preview.branch ?? `PR #${preview.pr}`} copy`} lines={[`${preview.stack}/${d.cluster}`, d.outcome?.message ?? (preview.data.scrub ? 'copied · scrubbed' : 'copied')]} tone={tone} />
      </div>
      <ul aria-label="How the copy is made" className="flex flex-col gap-1.5">
        {steps.map(([t, m]) => (
          <li key={t} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[13px]">
            <span aria-hidden className={cn('size-2 shrink-0 translate-y-[-1px] rounded-full', TONE_DOT[tone])} />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t}</span>
            {m ? <span className="text-muted-foreground min-w-0 basis-full pl-[18px] font-mono text-[11px] break-words sm:basis-auto sm:pl-0">{m}</span> : null}
          </li>
        ))}
      </ul>
      <Tech>{`previews.data.from: ${preview.data.from}${preview.data.scrub ? ` · scrub: ${preview.data.scrub}` : ''} · audited as app.preview.data`}</Tech>
    </div>
  );
}
