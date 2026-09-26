import * as React from 'react';
import type { ServiceDetail } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, type Tone } from '@/components/calm';
import type { StackAppMatch } from '@/components/gitops/gitops-types';

export function serviceTone(s: Pick<ServiceDetail, 'status' | 'replicas'>): Tone {
  if (s.status === 'failed') return 'bad';
  if (s.status === 'degraded' || (s.replicas.desired > 0 && s.replicas.running < s.replicas.desired && s.status !== 'deploying')) return 'warn';
  if (s.status === 'deploying' || s.status === 'pending') return 'info';
  if (s.status === 'stopped' || s.replicas.desired === 0) return 'idle';
  return 'ok';
}

/** "2/2 running" in the part's tone. */
export function RunningPill({ service }: { service: Pick<ServiceDetail, 'status' | 'replicas'> }): React.JSX.Element {
  const tone = serviceTone(service);
  const word = tone === 'idle' ? 'stopped' : tone === 'info' ? 'starting' : 'running';
  return (
    <span className={cn('bg-muted inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-semibold', TONE_TEXT[tone])}>
      <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
      {service.replicas.running}/{service.replicas.desired} {word}
    </span>
  );
}

/** Where this part's settings come from: "storefront/api in swarmy.yaml", or "dashboard". */
export function SourcePill({ git, stack, name }: { git: StackAppMatch | null | undefined; stack: string | null; name: string }): React.JSX.Element | null {
  if (git === undefined) return null;
  const short = shortName(name, stack);
  return (
    <span className="text-tone-mesh bg-tone-mesh/10 inline-flex max-w-full items-center truncate rounded-md px-1.5 py-0.5 font-mono text-[11px]">
      {git ? `${stack ?? git.app.appName ?? 'app'}/${short} in ${git.app.configPath.split('/').pop()}` : 'dashboard'}
    </span>
  );
}

/** The part's short name inside its app (`storefront_api` → `api`). */
export function shortName(name: string, stack: string | null): string {
  return stack && name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name;
}
