import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ServiceRemoveConfirm } from './service-remove-confirm';

interface ServiceDangerSectionProps {
  serviceId: string;
  serviceName: string;
}

/** "Danger" — the one irreversible action, kept quiet and behind a confirm. */
export function ServiceDangerSection({ serviceId, serviceName }: ServiceDangerSectionProps): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const remove = useMutation(
    trpc.services.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Service removed');
        void navigate({ to: '/' });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="calm-card border-status-offline/30 mt-6 max-w-xl border shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Remove this service</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-muted-foreground text-sm">
          Stops every replica and deletes the service from the swarm. Volumes and data stay put.
        </p>
        <ServiceRemoveConfirm
          name={serviceName}
          pending={remove.isPending}
          onConfirm={() => remove.mutate({ id: serviceId })}
        />
      </CardContent>
    </Card>
  );
}
