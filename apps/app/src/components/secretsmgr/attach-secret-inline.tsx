import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SecretFamilyView } from '@swarmy/core';
import { Button, Collapsible, CollapsibleContent, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StackServiceSelect } from './stack-service-select';

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface AttachSecretInlineProps {
  family: SecretFamilyView;
  stack: string;
  open: boolean;
  onDone: () => void;
}

/**
 * Inline attach (expands under the row, no modal): mount the current version
 * into one of THIS stack's services at the stable /run/secrets path, with an
 * optional env var pointing at it. The service restarts once.
 */
export function AttachSecretInline({
  family,
  stack,
  open,
  onDone,
}: AttachSecretInlineProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [service, setService] = React.useState('');
  const [envName, setEnvName] = React.useState('');

  const attach = useMutation(
    trpc.secrets.attach.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.family} mounted into ${r.service} at ${r.mountPath}`);
        setService('');
        setEnvName('');
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const envOk = envName.trim() === '' || ENV_RE.test(envName.trim());

  return (
    <Collapsible open={open}>
      <CollapsibleContent>
        <div className="border-border bg-card space-y-3 rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">
            The service restarts once and reads the value from{' '}
            <code className="mono-data">/run/secrets/{family.family}</code> — rotations swap the
            value without touching the path.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <StackServiceSelect
              stack={stack}
              value={service}
              onChange={setService}
              exclude={family.consumers.map((c) => c.serviceName)}
              emptyHint="Every service in this stack already has this secret (or none are deployed)."
            />
            <div className="grid content-start gap-1.5">
              <Label className="mono-label">Env var (optional)</Label>
              <Input
                value={envName}
                onChange={(e) => setEnvName(e.target.value)}
                placeholder={`${family.family}_FILE`}
                className="mono-data"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={!service || !envOk || attach.isPending}
              onClick={() =>
                attach.mutate({
                  family: family.family,
                  service,
                  ...(envName.trim() ? { envName: envName.trim() } : {}),
                })
              }
            >
              {attach.isPending ? 'Attaching…' : 'Attach & restart'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
