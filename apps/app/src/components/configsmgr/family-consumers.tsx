import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { UnlinkIcon } from 'lucide-react';
import type { ConfigFamilyView } from '@swarmy/core';
import { Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Who reads this config: consumer rows with links + one-click detach. */
export function FamilyConsumers({ family }: { family: ConfigFamilyView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const detach = useMutation(
    trpc.configs.detach.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.family} detached from ${r.service}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">
        Used by {family.usedByCount} service{family.usedByCount === 1 ? '' : 's'}
      </p>
      {family.consumers.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Nothing reads this config yet — attach it to a service above.
        </p>
      ) : (
        <div className="divide-border border-border divide-y rounded-xl border">
          {family.consumers.map((c) => (
            <div key={c.serviceId} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <Link
                  to="/services/$serviceId"
                  params={{ serviceId: c.serviceId }}
                  className="mono-data hover:text-primary block truncate text-sm font-semibold transition-colors"
                >
                  {c.serviceName}
                </Link>
                <p className="text-muted-foreground truncate text-xs">
                  {c.stack} · reading v{c.version}
                </p>
              </div>
              <StatusBadge
                tone={c.upToDate ? 'online' : 'warning'}
                label={c.upToDate ? 'current' : `v${c.version}`}
              />
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground size-7 p-0"
                title={`Detach from ${c.serviceName}`}
                disabled={detach.isPending}
                onClick={() => detach.mutate({ family: family.family, service: c.serviceName })}
              >
                <UnlinkIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
