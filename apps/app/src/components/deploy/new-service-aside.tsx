import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { Loader2Icon } from 'lucide-react';
import type { CreateServiceInput } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { AlreadyOn, CodeView, Tech, curl } from '@/components/calm';

type FormValues = z.input<typeof CreateServiceInput>;

/** The image deploy's aside: the same call over REST (Code), what happens, Deploy. */
export function NewServiceAside({
  form,
  pending,
  onCancel,
}: {
  form: UseFormReturn<FormValues>;
  pending: boolean;
  onCancel: () => void;
}): React.JSX.Element {
  const v = form.watch();
  const env = (v.env ?? []).filter((e) => e?.key).map((e) => ({ key: e.key, value: e.value ?? '' }));
  const body = {
    name: v.name || 'web',
    image: v.image || 'nginx:1.27',
    replicas: Number(v.replicas ?? 1),
    ...(env.length ? { env } : {}),
  };
  const copies = Number(v.replicas ?? 1);
  return (
    <>
      <CodeView
        tabs={[{ label: 'REST', code: curl('POST', '/services', body) }]}
        note="The same deploy over REST. Ports, the app it joins and the web address are dashboard fields for now."
      />
      <section aria-label="What happens" className="calm-card flex flex-col gap-3 px-5 py-5">
        <h2 className="font-display text-[1.2rem] font-bold tracking-[-0.01em]">
          {v.image ? `${v.image.split('/').pop()}, ${copies} ${copies === 1 ? 'copy' : 'copies'}.` : 'One image, running.'}
        </h2>
        <AlreadyOn
          bare
          items={[
            { what: 'Placed for you', detail: 'swarmy picks a server with room' },
            { what: 'Restarts itself', detail: 'if it stops, it comes back' },
            { what: 'Web address', detail: v.ingress?.enabled ? 'HTTPS at the address you gave' : 'add one here or later' },
          ]}
        />
        <Tech>
          {[`replicas=${copies}`, v.project ? `stack=${v.project}` : null, `${(v.ports ?? []).length} ports`, `${(v.env ?? []).length} env`]
            .filter(Boolean)
            .join(' · ')}
        </Tech>
        <div className="flex flex-col gap-2 pt-1">
          <Button type="submit" size="lg" disabled={pending} className="pointer-coarse:min-h-11 w-full">
            {pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {v.name ? `Deploy ${v.name}` : 'Deploy'}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} className="pointer-coarse:min-h-11">
            Cancel
          </Button>
        </div>
      </section>
    </>
  );
}
