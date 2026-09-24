import * as React from 'react';
import { PlusIcon, ShieldCheckIcon } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@swarmy/ui';
import { CardSkeleton, ErrorState } from '@/components/states';
import { SecretVarForm } from './secret-var-form';
import { ServiceSecretVarRow } from './service-secret-var-row';
import { useSecretVars } from './use-secret-vars';

interface ServiceSecretVarsCardProps {
  serviceId: string;
}

/**
 * Secret variables — stored as Docker Swarm secrets (encrypted in the raft
 * log, only on this service's tasks, tmpfs at /run/secrets). Write-only:
 * after save the value is never shown; reveal is permission-gated + audited.
 */
export function ServiceSecretVarsCard({ serviceId }: ServiceSecretVarsCardProps): React.JSX.Element {
  const s = useSecretVars(serviceId);
  const [adding, setAdding] = React.useState(false);
  const pending = s.set.isPending || s.remove.isPending;

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <ShieldCheckIcon className="text-status-online size-4" /> Secrets
          </span>
          {!adding && (
            <Button variant="outline" size="sm" className="rounded-full font-bold" onClick={() => setAdding(true)}>
              <PlusIcon className="size-4" /> Add secret
            </Button>
          )}
        </CardTitle>
        <p className="text-muted-foreground text-xs">
          Encrypted Docker secrets, delivered only to this service. Never in the spec, never shown again after save.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {adding && (
          <SecretVarForm
            pending={pending}
            onCancel={() => setAdding(false)}
            onSubmit={(v) => {
              s.set.mutate({ id: serviceId, ...v });
              setAdding(false);
            }}
          />
        )}
        {s.vars.isPending ? (
          <CardSkeleton />
        ) : s.vars.isError ? (
          <ErrorState title="Couldn’t load secrets." error={s.vars.error} retry={() => void s.vars.refetch()} />
        ) : s.vars.data.length === 0 ? (
          !adding && (
            <EmptyState
              icon={<ShieldCheckIcon />}
              title="No secrets yet"
              description="Keep passwords and API keys out of plain env — add one here."
            />
          )
        ) : (
          <ul className="divide-y">
            {s.vars.data.map((v) => (
              <ServiceSecretVarRow
                key={v.key}
                v={v}
                pending={pending}
                revealed={s.revealed?.key === v.key ? s.revealed.value : null}
                onReveal={() => s.reveal.mutate({ id: serviceId, key: v.key })}
                onHide={s.hide}
                onRemove={() => s.remove.mutate({ id: serviceId, key: v.key })}
                onSave={(value, delivery) => s.set.mutate({ id: serviceId, key: v.key, value, delivery })}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
