import type { StatusTone } from '@swarmy/ui';

/** Plan row status → StatusBadge tone + plain words. */
export function planStatus(status: string): { tone: StatusTone; label: string } {
  switch (status) {
    case 'applied':
      return { tone: 'online', label: 'Live' };
    case 'applying':
      return { tone: 'progress', label: 'Rolling out' };
    case 'planned':
      return { tone: 'progress', label: 'Planned' };
    case 'needs-confirmation':
      return { tone: 'warning', label: 'Needs you' };
    case 'blocked':
      return { tone: 'offline', label: 'Blocked' };
    case 'failed':
      return { tone: 'offline', label: 'Failed' };
    case 'invalid':
      return { tone: 'offline', label: 'swarmy.yaml has errors' };
    case 'superseded':
      return { tone: 'neutral', label: 'Superseded' };
    default:
      return { tone: 'neutral', label: status.replace(/[-_]/g, ' ') };
  }
}

export const ENV_LABEL: Record<string, string> = {
  production: 'Production',
  staging: 'Staging',
  preview: 'Preview',
};

export const envLabel = (env: string): string =>
  ENV_LABEL[env] ?? env.charAt(0).toUpperCase() + env.slice(1);

export const sha7 = (sha: string): string => sha.slice(0, 7);

/** What confirming this action actually does, in plain words (the confirm dialog body). */
export function destroysWhat(a: {
  kind: string;
  name?: string;
  resourceType?: string;
  host?: string;
  path?: string;
  peer?: string;
  reason: string;
}): string {
  switch (a.kind) {
    case 'resource.delete':
      return `Deletes the ${a.resourceType ?? 'resource'} “${a.name}” and everything stored in it. This can’t be undone.`;
    case 'service.remove':
      return `Removes the service “${a.name}”. Anything calling it stops getting answers.`;
    case 'route.remove':
      return `Stops serving ${a.host ?? ''}${a.path ?? ''}. Visitors get a 404.`;
    case 'job.remove':
      return `Deletes the scheduled job “${a.name}”. It won’t run again.`;
    case 'link.remove':
      return `Cuts the private link to “${a.peer}”.`;
    default:
      return a.reason;
  }
}
