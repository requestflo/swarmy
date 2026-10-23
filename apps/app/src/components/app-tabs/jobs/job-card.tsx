import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRunView, ScheduledJobView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { runDuration, untilTime } from '@/components/jobs/job-status';
import { Segmented } from '@/components/service-settings/settings-row';
import { useTRPC } from '@/integrations/trpc';
import { shortName } from '../use-stack-services';
import { RunLog } from './run-log';
import { hhmm, plainSchedule } from './yesterday-model';

/** `sh -c "npm run x"` reads as `npm run x`. */
const commandLine = (c: string[]): string => (c[0] === 'sh' && c[1] === '-c' ? c.slice(2) : c).join(' ');

/**
 * The picked job (board AppJobs): its schedule in plain words (or as cron),
 * what it runs and where, Run now, and its last log. Editing stays in the
 * jobs list below.
 */
export function JobCard({ stack, job, runs }: { stack: string; job: ScheduledJobView; runs: JobRunView[] | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const words = plainSchedule(job);
  const [asCron, setAsCron] = React.useState(false);
  const [log, setLog] = React.useState(false);
  const runNow = useMutation(
    trpc.jobs.runNow.mutationOptions({
      onSuccess: () => {
        toast.success(`${job.name} is running`);
        setLog(true);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const last = runs?.[0];
  const where = job.kind === 'image' ? (job.image ?? 'its image') : job.serviceRef ? shortName(stack, job.serviceRef) : 'a service';
  const meta = [
    last ? `last run ${hhmm(last.startedAt)} UTC · ${last.status === 'succeeded' ? 'ok' : last.status}${last.finishedAt ? ` · ${runDuration(last.startedAt, last.finishedAt)}` : ''}` : 'never ran',
    job.enabled ? `next ${untilTime(job.nextRunAt)}` : 'paused',
  ].join(' · ');
  return (
    <Section title={<span className="font-mono text-[15px]">{job.name}</span>} hint={`${job.kind === 'image' ? 'in' : 'on'} ${where}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-56 text-[15px] font-semibold">{asCron || !words ? <span className="font-mono">{job.schedule}</span> : words}</p>
        <span className="text-muted-foreground font-mono text-[11.5px]">= {asCron || !words ? (words ?? 'cron only') : job.schedule}</span>
        {words ? (
          <Segmented
            label="Show the schedule as"
            options={[
              { value: 'words', label: 'Plain words' },
              { value: 'cron', label: 'cron' },
            ]}
            value={asCron ? 'cron' : 'words'}
            onChange={(v) => setAsCron(v === 'cron')}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="bg-muted min-w-0 flex-1 basis-56 truncate rounded-md px-2.5 py-1.5 font-mono text-[12.5px] [font-variant-ligatures:none]">{commandLine(job.command) || '(the image’s own command)'}</code>
        <Button size="sm" disabled={runNow.isPending} className="pointer-coarse:min-h-11" onClick={() => runNow.mutate({ id: job.id })}>
          {runNow.isPending ? 'Starting…' : 'Run now'}
        </Button>
        <Button size="sm" variant="outline" disabled={!last} className="pointer-coarse:min-h-11" onClick={() => setLog((v) => !v)}>
          {log ? 'Hide log' : 'Last log'}
        </Button>
      </div>
      <span className="text-muted-foreground font-mono text-[11.5px]">{meta}</span>
      {log && last ? <RunLog hour={null} runs={[last]} all={runs ?? []} name={job.name} onClose={() => setLog(false)} /> : null}
      <Tech>
        {job.kind} · {job.schedule} UTC · retries {job.retries} · timeout {Math.round(job.timeoutMs / 60_000)} min{job.alertOnFailure ? ' · alerts on failure' : ''}
      </Tech>
    </Section>
  );
}
