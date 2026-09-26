import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { Tech } from '@/components/calm';
import { orderOf, parallelismOf, restartOf, sayDuration, type DeployOrder, type RestartWhen, type SettingsDraft } from './settings-model';
import { Segmented, SettingRow } from './settings-row';

const RESTART: { value: RestartWhen; label: string }[] = [
  { value: 'on-failure', label: 'On failure' },
  { value: 'any', label: 'Always' },
  { value: 'none', label: 'Never' },
];
const ORDER: { value: DeployOrder; label: string }[] = [
  { value: 'start-first', label: 'Start new first' },
  { value: 'stop-first', label: 'Stop old first' },
];

function crashSay(when: RestartWhen, spec: ServiceSpec): string {
  if (when === 'none') return 'If it crashes, it stays down until someone starts it.';
  const max = spec.restartPolicy?.maxAttempts;
  const gap = sayDuration(spec.restartPolicy?.delayNs);
  const limits = [max ? `up to ${max} times` : null, gap ? `${gap.replace('s', ' s')} apart` : null].filter(Boolean).join(', ');
  const base = when === 'on-failure' ? 'If it crashes, swarmy starts it again' : 'Whenever it stops, even cleanly, swarmy starts it again';
  return `${base}${limits ? ` (${limits})` : ''}.`;
}

interface RowProps {
  spec: ServiceSpec;
  draft: SettingsDraft;
  set: (p: SettingsDraft) => void;
}

export function CrashRow({ spec, draft, set }: RowProps): React.JSX.Element {
  const when = draft.restart ?? restartOf(spec);
  const rp = spec.restartPolicy;
  return (
    <SettingRow title="If it crashes">
      <p className="text-[13.5px]">{crashSay(when, spec)}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented label="If it crashes" options={RESTART} value={when} onChange={(v) => set({ restart: v })} />
        <Tech>
          restart_policy {when}
          {rp?.maxAttempts ? ` · max ${rp.maxAttempts}` : ' · no attempt limit'}
          {rp?.delayNs !== undefined ? ` · ${sayDuration(rp.delayNs)} apart` : ''}
          {rp ? '' : ' (Docker default)'}
        </Tech>
      </div>
    </SettingRow>
  );
}

export function DeployRow({ spec, draft, set, stack }: RowProps & { stack: string | null }): React.JSX.Element {
  const order = draft.order ?? orderOf(spec);
  const p = parallelismOf(spec);
  return (
    <SettingRow title="During a deploy">
      <p className="text-[13.5px]">
        {order === 'start-first'
          ? 'A new copy starts and passes its health check before an old one stops, so nothing goes dark.'
          : 'An old copy stops before its new one starts. Safer for parts that must never run twice.'}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented label="During a deploy" options={ORDER} value={order} onChange={(v) => set({ order: v })} />
        <Tech>
          update_config order {order} · parallelism {p}
          {spec.updateConfig?.failureAction ? ` · on failure ${spec.updateConfig.failureAction}` : ''}
        </Tech>
      </div>
      {stack ? (
        <Link
          to="/stacks/$name/config/rollout"
          params={{ name: stack }}
          className="text-primary inline-flex min-h-8 w-fit items-center text-[13px] underline-offset-2 hover:underline pointer-coarse:min-h-11"
        >
          Health check &amp; canary →
        </Link>
      ) : null}
    </SettingRow>
  );
}
