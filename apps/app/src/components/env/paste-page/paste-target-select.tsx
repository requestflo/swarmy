import * as React from 'react';
import { envLabel } from '@/components/gitops/plan-status';
import { SHARED } from './paste-target';

const sel = 'border-border bg-background h-9 rounded-[8px] border px-2 font-mono text-[15px] font-semibold pointer-coarse:min-h-11';

/**
 * Which environment the paste goes to (board 58): each environment that runs
 * the service, and — with two or more — every environment at once, as the
 * shared value each environment's own values still win over.
 */
export function PasteTargetSelect({
  environments,
  value,
  onChange,
}: {
  environments: string[];
  value: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <select aria-label="Environment" value={value} className={sel} onChange={(e) => onChange(e.target.value)}>
      {environments.map((e) => (
        <option key={e} value={e}>
          {envLabel(e)}
        </option>
      ))}
      {environments.length > 1 ? <option value={SHARED}>Every environment</option> : null}
    </select>
  );
}

/** The tech line under the title: what the picked target means. */
export function targetWords(target: string, here: string, environments: string[]): string {
  if (target === SHARED) {
    return `Shared: ${environments.join(', ')} each get it, except where an environment sets its own value (it differs from production's), which wins — as environments.<name>.env wins over env: in swarmy.yaml.`;
  }
  const where = target === here ? 'this environment' : `${target} (its own stack)`;
  return `An override for ${where} only: the others keep their values. It stays a dashboard setting until a deploy from swarmy.yaml rewrites the service.`;
}
