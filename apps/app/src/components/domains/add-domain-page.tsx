import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { CalmTopBar, Depth, SayHeader } from '@/components/calm';
import { useAddDomain } from './use-add-domain';
import { useAutoAddress, useDomainPlan, useSuggestedPort, useTargets } from './use-add-targets';
import { AddDomainWhat } from './add-domain-what';
import { AddDomainOptions } from './add-domain-options';
import { AddDomainRecords } from './add-domain-records';
import { AddDomainCode, EdgeTech } from './add-domain-code';

/**
 * "Add a domain" (board 28): step 1 says what and where, step 2 is exactly the
 * records to create. The one action adds the domain (if it isn't yet), checks
 * DNS now and opens the verification view.
 */
export function AddDomainPage({ app, host }: { app?: string; host?: string }): React.JSX.Element {
  const { form, set, ready, submit, pending } = useAddDomain({ host });
  const { targets } = useTargets();
  const { plan, checking } = useDomainPlan(form.host);
  const target = targets.find((t) => t.serviceId === form.serviceId) ?? null;
  const suggested = useSuggestedPort(form.serviceId);
  const { autoAddress, routed } = useAutoAddress(form.serviceId);

  // Preselect the app's first service (from ?app=), then its listening port.
  React.useEffect(() => {
    if (form.serviceId || targets.length === 0) return;
    const inApp = targets.filter((t) => t.stack === app);
    // Prefer the service that already has an automatic address (the app's public front end).
    const pick = inApp.find((t) => routed.has(t.serviceId)) ?? inApp[0] ?? (targets.length === 1 ? targets[0] : undefined);
    if (pick) set('serviceId', pick.serviceId);
  }, [app, targets, routed, form.serviceId, set]);
  React.useEffect(() => {
    if (suggested) set('port', suggested);
  }, [form.serviceId, suggested, set]);

  const appName = target?.stack ?? app ?? 'your app';
  const back = app ? { to: '/stacks/$name/network', params: { name: app } } : { to: '/network' };
  return (
    <div className="flex min-h-full flex-col">
      <CalmTopBar
        crumbs={[{ label: 'Network', to: '/network' }, { label: 'add a domain' }]}
        actions={
          <>
            <Button asChild variant="outline" className="pointer-coarse:min-h-11">
              <Link to={back.to} params={back.params as never}>Cancel</Link>
            </Button>
            <Button onClick={() => void submit()} disabled={!ready || pending} className="pointer-coarse:min-h-11">
              {pending ? 'Checking…' : <>I’ve added them <ArrowRightIcon className="size-4" /> Check</>}
            </Button>
          </>
        }
      />
      <div className="mx-auto grid w-full max-w-[1600px] flex-1 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <section aria-label="Step 1" className="flex min-w-0 flex-col gap-6 px-4 pt-7 pb-8 sm:px-6 xl:px-8">
          <SayHeader
            size="md"
            eyebrow="Step 1 of 2 · what and where"
            title={<>Point a domain at {appName}.</>}
            lede="Say where it goes, then add the records on the right at your registrar. swarmy gets HTTPS by itself."
          />
          <AddDomainWhat form={form} set={set} targets={targets} plan={plan} autoAddress={autoAddress} />
          <AddDomainOptions form={form} set={set} plan={plan} />
        </section>
        <section aria-label="Step 2" className="border-border flex min-w-0 flex-col gap-4 border-t px-4 pt-7 pb-24 sm:px-6 lg:border-t-0 lg:border-l lg:pb-16 xl:px-8">
          <Depth at="code">
            <AddDomainCode form={form} target={target} />
          </Depth>
          <AddDomainRecords form={form} set={set} plan={plan} checking={checking} service={target ? `${target.name} :${form.port}` : null} />
          <EdgeTech plan={plan} />
        </section>
      </div>
    </div>
  );
}
