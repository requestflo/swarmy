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

/**
 * The running PLAIN env (secret-looking values masked — they are still plain;
 * the hint nudges to Secrets) + bulk `.env` paste applied in one deploy, where
 * rows marked secret are stored as Docker secrets.
 */
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
        {entries.some(([k, v]) => looksSecret(k, v)) && (
          <p className="text-status-warning mt-2 text-xs">
            Some values look like secrets but are plain env (visible in the service spec). Paste them again marked
            secret, or add them under Secrets.
          </p>
        )}
      </CardContent>
      <EnvPasteDialog
        open={open}
        onOpenChange={setOpen}
        current={env}
        parseOptions={SERVICE_ENV_PARSE}
        applyLabel="Apply & deploy"
        pending={update.isPending}
        onApply={(next, secretKeys) =>
          update.mutate({
            id: serviceId,
            // Keys marked secret become Docker secrets (write-only); the rest stay plain env.
            env: Object.entries(next).map(([key, value]) => ({ key, value, ...(secretKeys.has(key) ? { secret: true } : {}) })),
          })
        }
      />
    </Card>
  );
}
