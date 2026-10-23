import * as React from 'react';
import { shortName } from '../use-stack-services';
import { CopiesBlock } from './copies-block';
import { ServerStrip } from './server-strip';
import { SizeBlock } from './size-block';
import { sizeWords } from './size-model';
import { SleepBlock } from './sleep-block';
import { serverCards } from './strip-model';
import type { ScalingPage } from './use-scaling-page';

/**
 * The picked service (board AppScaling): where its copies run, then copies +
 * size of each copy beside sleep when idle and yesterday's replay.
 */
export function ServiceScaling({ stack, page }: { stack: string; page: ScalingPage }): React.JSX.Element | null {
  const { picked, nodes, servicesByNode, svc, draft } = page;
  const cards = React.useMemo(
    () =>
      picked && nodes && servicesByNode
        ? serverCards({
            nodes,
            servicesByNode,
            serviceId: picked.inv.id,
            running: picked.inv.replicas.running,
            label: (n) => shortName(stack, n),
          })
        : undefined,
    [picked, nodes, servicesByNode, stack],
  );
  if (!picked) return null;
  const { inv, detail } = picked;
  const name = shortName(stack, inv.name);
  const limits = svc.spec?.resources?.limits;
  return (
    <div className="@container flex flex-col gap-5">
      <ServerStrip
        name={name}
        desired={inv.replicas.desired}
        running={inv.replicas.running}
        sizeLabel={svc.spec ? (limits ? sizeWords(limits) : 'no ceiling') : undefined}
        address={svc.address}
        cards={cards}
      />
      <div className="grid items-start gap-5 @3xl:grid-cols-2">
        <section aria-label={`Copies and size of ${name}`} className="calm-card flex flex-col gap-4 px-5 py-4">
          <CopiesBlock inv={inv} name={name} cards={cards} />
          <hr className="border-border" />
          <SizeBlock spec={svc.spec} usage={svc.usage} draft={draft} />
        </section>
        <section aria-label={`Sleep when idle for ${name}`} className="calm-card flex flex-col px-5 py-4">
          <SleepBlock key={inv.id} stack={stack} inv={inv} detail={detail} name={name} address={svc.address} />
        </section>
      </div>
    </div>
  );
}
