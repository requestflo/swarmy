import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CopyButton } from '@swarmy/ui';
import { CalmRow, Depth, NextAction, RowList, Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { MTU_MANUAL_STEP, mtuAllSteps, mtuFixLine, mtuLede, mtuRowSub } from './mesh-mtu-words';

/**
 * "Networks are too big for the mesh": the private network's tunnel (wt0)
 * carries smaller packets than an overlay sends, so large transfers between
 * servers stall. Quiet unless it bites (the check is `mesh.mtu`, from what the
 * agents report). There is no Fix button: an existing network's size is fixed
 * when it's created and swarmy has no safe way to recreate one under running
 * apps, so this shows the manual step. New networks swarmy creates already fit.
 */
export function MeshMtuCard(): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.mesh.mtu.queryOptions(), refetchInterval: 60_000 });
  const v = q.data;
  if (!v || v.status !== 'too-big') return null;
  const steps = mtuAllSteps(v);

  return (
    <div className="flex flex-col gap-3">
      <NextAction
        eyebrow="Needs you"
        title="Networks are too big for the mesh."
        tech={`${v.iface ?? 'wt0'} mtu ${v.linkMtu} · containers get the option − 50 VXLAN (− 26 ESP when encrypted) · --opt com.docker.network.driver.mtu=${v.option}`}
      >
        <p>{mtuLede(v)}</p>
        <p className="text-foreground mt-1.5 font-medium">{mtuFixLine(v)}</p>
      </NextAction>
      <Section title="Networks to make smaller" count={v.tooBig.length} hint="by hand, when the apps on them can take a break">
        <p className="text-muted-foreground text-[13px] leading-relaxed">{MTU_MANUAL_STEP}</p>
        <RowList label="Networks too big for the mesh">
          {v.tooBig.map((f) => (
            <CalmRow
              key={f.name}
              tone="warn"
              name={f.name}
              sub={mtuRowSub(f, v.services[f.name] ?? [])}
              say={`${f.mtu} now, fits at ${f.fits}${f.encrypted ? ' (encrypted)' : ''}`}
              word={f.managed ? 'made by swarmy' : 'made outside swarmy'}
              wordTone="idle"
            />
          ))}
        </RowList>
        <Depth at="controls">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <h3 className="calm-eyebrow">The steps, as commands</h3>
              <CopyButton value={steps} className="ml-auto size-8" />
            </div>
            <pre tabIndex={0} aria-label="Commands to recreate the networks" className="calm-code max-h-[360px] overflow-auto px-4 py-3 whitespace-pre">
              {steps}
            </pre>
          </div>
        </Depth>
      </Section>
    </div>
  );
}
