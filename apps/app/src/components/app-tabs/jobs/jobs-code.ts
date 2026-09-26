import type { ScheduledJobView } from '@swarmy/core';
import { toYaml, withHeader, type CodeTab } from '@/components/calm';

/** The scheduled jobs as swarmy.yaml. */
export function jobsCode(stack: string, jobs: ScheduledJobView[]): CodeTab[] {
  const jobsYaml: Record<string, { schedule: string; service?: string; image?: string; run: string; retries?: number }> = {};
  for (const j of jobs) {
    const svc = j.serviceRef?.startsWith(`${stack}_`) ? j.serviceRef.slice(stack.length + 1) : j.serviceRef;
    jobsYaml[j.name] = {
      schedule: j.schedule,
      ...(svc ? { service: svc } : j.image ? { image: j.image } : {}),
      run: j.command.join(' '),
      ...(j.retries ? { retries: j.retries } : {}),
    };
  }
  return [{ label: 'swarmy.yaml', code: withHeader(`${stack} — scheduled jobs`, toYaml({ jobs: jobsYaml })) }];
}
