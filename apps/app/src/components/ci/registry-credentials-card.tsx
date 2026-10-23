import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import { RegistryCredentialForm } from './registry-credential-form';
import { RegistryCredentialRow } from './registry-credential-row';
import { RegistryCredentialsBuiltin } from './registry-credentials-builtin';
import { RegistryCredentialsMatcher } from './registry-credentials-matcher';
import { resolveImageLogin } from './registry-credentials-resolve';

/**
 * Private registry logins (GHCR, Docker Hub, GitLab, ECR/GCR/ACR, any host).
 * Matched to images by the longest registry/path prefix and attached to every
 * deploy, pull and build automatically. Tokens are write-only.
 */
export function RegistryCredentialsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery(trpc.registryCredentials.list.queryOptions());
  const registry = useQuery(trpc.cicd.getRegistryConfig.queryOptions());
  const [adding, setAdding] = React.useState(false);
  const [image, setImage] = React.useState('');
  const builtinHost = registry.data?.enabled ? registry.data.host : null;
  const resolution = list.data ? resolveImageLogin(image, list.data, builtinHost) : null;
  const hitId = resolution?.kind === 'login' ? resolution.cred.id : null;
  const refresh = (): void => void qc.invalidateQueries({ queryKey: trpc.registryCredentials.list.queryKey() });

  return (
    <Card className="calm-card border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          Private registries
          {!adding && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <PlusIcon className="size-4" /> Add login
            </Button>
          )}
        </CardTitle>
        <CardDescription>
          Pull private images from GHCR, Docker Hub, GitLab, ECR, Artifact Registry, ACR or any registry. swarmy picks
          the login whose registry path matches the image and sends it with every deploy and build. You can't
          view a token after you save it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {adding && (
          <RegistryCredentialForm
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              refresh();
            }}
          />
        )}
        <RegistryCredentialsBuiltin config={registry.data} hit={resolution?.kind === 'builtin'} />
        {list.isPending ? (
          <CardSkeleton />
        ) : list.isError ? (
          <ErrorState error={list.error} retry={() => void list.refetch()} />
        ) : list.data.length === 0 ? (
          !adding && (
            <EmptyState
              icon={<KeyRoundIcon />}
              title="No private registry logins"
              description="Add one to deploy images like ghcr.io/you/app:1.2."
            />
          )
        ) : (
          list.data.map((c) => <RegistryCredentialRow key={c.id} cred={c} hit={c.id === hitId} onChanged={refresh} />)
        )}
        {list.data ? <RegistryCredentialsMatcher value={image} onChange={setImage} resolution={resolution} /> : null}
      </CardContent>
    </Card>
  );
}
