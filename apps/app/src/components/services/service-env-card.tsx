import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardPasteIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import { looksSecret, maskValue } from '@swarmy/core';
import { Button, Card, CardContent, CardHeader, CardTitle, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EnvPasteDialog, SERVICE_ENV_PARSE } from '@/components/env/env-paste-dialog';

interface ServiceEnvCardProps {
  serviceId: string;
  env: Record<string, string>;
}

/** The running env (secret-looking values masked) + bulk `.env` paste applied in one deploy. */
export function ServiceEnvCard({ serviceId, env }: ServiceEnvCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [reveal, setReveal] = React.useState(false);
  const entries = Object.entries(env);

  const update = useMutation(
    trpc.services.update.mutationOptions({
      onSuccess: () => {
        toast.success('Environment updated — rolling out');
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          Environment
          <span className="flex items-center gap-1">
            {entries.some(([k, v]) => looksSecret(k, v)) && (
              <Button variant="ghost" size="sm" onClick={() => setReveal((r) => !r)}>
                {reveal ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />} {reveal ? 'Hide' : 'Reveal'}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              <ClipboardPasteIcon className="size-4" /> Paste .env
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {entries.length ? (
          <pre className="bg-muted overflow-x-auto rounded-xl p-3 font-mono text-xs">
            {entries.map(([k, v]) => `${k}=${!reveal && looksSecret(k, v) ? maskValue(v) : v}`).join('\n')}
          </pre>
        ) : (
          <p className="text-muted-foreground">Nothing set. This service runs clean.</p>
        )}
      </CardContent>
      <EnvPasteDialog
        open={open}
        onOpenChange={setOpen}
        current={env}
        parseOptions={SERVICE_ENV_PARSE}
        applyLabel="Apply & deploy"
        pending={update.isPending}
        onApply={(next) =>
          update.mutate({ id: serviceId, env: Object.entries(next).map(([key, value]) => ({ key, value })) })
        }
      />
    </Card>
  );
}
