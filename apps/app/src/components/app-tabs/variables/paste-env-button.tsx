import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardPasteIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EnvPasteDialog, SERVICE_ENV_PARSE } from '@/components/env/env-paste-dialog';

/**
 * "Paste .env" for one service of the app: reads the service's current env when
 * opened, previews the diff, and applies it in one rolling update. Rows marked
 * secret become Docker secrets (write-only), the rest stay plain.
 */
export function PasteEnvButton({ serviceId, label }: { serviceId: string; label: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const svc = useQuery({ ...trpc.services.get.queryOptions({ id: serviceId }), enabled: open });
  const update = useMutation(
    trpc.services.update.mutationOptions({
      onSuccess: () => {
        toast.success(`${label}: new settings are rolling out, one copy at a time`);
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <>
      <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => setOpen(true)}>
        <ClipboardPasteIcon className="size-3.5" /> Paste .env into {label}
      </Button>
      <EnvPasteDialog
        open={open && !!svc.data}
        onOpenChange={setOpen}
        current={svc.data?.env ?? {}}
        parseOptions={SERVICE_ENV_PARSE}
        applyLabel={`Apply to ${label}`}
        pending={update.isPending}
        onApply={(next, secretKeys) =>
          update.mutate({
            id: serviceId,
            env: Object.entries(next).map(([key, value]) => ({ key, value, ...(secretKeys.has(key) ? { secret: true } : {}) })),
          })
        }
      />
    </>
  );
}
