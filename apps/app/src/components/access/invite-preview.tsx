import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, XIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';
import { Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { previewLines, previewTech, type PreviewLine } from './invite-preview-words';
import type { RoleKey } from './role-lines';

function Lines({ title, lines, ok }: { title: string; lines: PreviewLine[]; ok: boolean }): React.JSX.Element | null {
  if (!lines.length) return null;
  const Icon = ok ? CheckIcon : XIcon;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="calm-eyebrow">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {lines.map((l) => (
          <li key={l.key} className={ok ? 'flex gap-2 text-[13px] leading-snug' : 'text-muted-foreground flex gap-2 text-[13px] leading-snug'}>
            <Icon aria-hidden className={ok ? 'text-tone-ok mt-0.5 size-3.5 shrink-0' : 'text-tone-bad mt-0.5 size-3.5 shrink-0'} strokeWidth={2.6} />
            <span>
              {l.text}
              {l.policy ? <span className="text-tone-warn ml-1.5 font-mono text-[11px]">Blocked by policy “{l.policy}”</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The live "They can / They can't" preview: the org's real rules, run for
 * someone with this role (and operator on the picked app) over its real apps.
 */
export function InvitePreview({ role, stackName }: { role: RoleKey; stackName: string | null }): React.JSX.Element {
  const trpc = useTRPC();
  const sim = useQuery({
    ...trpc.policies.simulateInvite.queryOptions({ role, stackNames: stackName ? [stackName] : [] }),
    placeholderData: (prev) => prev,
  });
  if (!sim.data) {
    return sim.isError ? <p className="text-muted-foreground text-xs">Couldn’t check the rules: {sim.error.message}</p> : <CardSkeleton lines={3} />;
  }
  const { can, cant } = previewLines(sim.data.verdicts, sim.data.appCount);
  return (
    <div className="flex flex-col gap-3" aria-live="polite" aria-busy={sim.isFetching}>
      <Lines title="They can" lines={can} ok />
      <Lines title="They can’t" lines={cant} ok={false} />
      <Tech>{previewTech(sim.data.verdicts)}</Tech>
    </div>
  );
}
