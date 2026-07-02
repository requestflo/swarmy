import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  StatusBadge,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Image policy card (slice D3): the two admission toggles — signed images only,
 * block critical CVEs — plus the org cosign signing-key status with a one-time
 * "Generate signing key" action. Every deploy runs these gates.
 */
export function ScanPolicyCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policy = useQuery(trpc.registryPolicy.getPolicy.queryOptions());
  const signing = useQuery(trpc.registryPolicy.signingStatus.queryOptions());

  const setPolicy = useMutation(
    trpc.registryPolicy.setPolicy.mutationOptions({
      onSuccess: () => {
        toast.success('Image policy updated');
        qc.invalidateQueries({ queryKey: trpc.registryPolicy.getPolicy.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const enableSigning = useMutation(
    trpc.registryPolicy.enableSigning.mutationOptions({
      onSuccess: () => {
        toast.success('Signing key generated — new builds are signed automatically');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const signingEnabled = !!signing.data?.enabled;
  const keySnippet = signing.data?.publicKey
    ?.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '')
    .slice(0, 24);

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          Image policy
          <StatusBadge
            tone={signingEnabled ? 'online' : 'neutral'}
            label={signingEnabled ? 'Signing on' : 'Signing off'}
          />
        </CardTitle>
        <CardDescription>
          Every deploy is checked against these gates. Built images are CVE-scanned automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="bg-accent/40 flex items-center justify-between gap-3 rounded-xl px-4 py-3">
          <div>
            <Label className="font-medium">Block critical vulnerabilities</Label>
            <p className="text-muted-foreground text-xs">
              Refuse deploys of images whose latest scan found critical CVEs.
            </p>
          </div>
          <Switch
            checked={!!policy.data?.blockCriticalCves}
            disabled={policy.isPending || setPolicy.isPending}
            onCheckedChange={(v) => setPolicy.mutate({ blockCriticalCves: v })}
          />
        </div>
        <div className="bg-accent/40 flex items-center justify-between gap-3 rounded-xl px-4 py-3">
          <div>
            <Label className="font-medium">Only deploy signed images</Label>
            <p className="text-muted-foreground text-xs">
              Require a valid cosign signature from your org key. Fails closed.
            </p>
          </div>
          <Switch
            checked={!!policy.data?.requireSignedImages}
            disabled={policy.isPending || setPolicy.isPending}
            onCheckedChange={(v) => setPolicy.mutate({ requireSignedImages: v })}
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
          <div className="min-w-0">
            <Label className="font-medium">Org signing key</Label>
            {signingEnabled ? (
              <p className="mono-data text-muted-foreground truncate text-xs">
                cosign · {keySnippet}…
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                No keypair yet. The private key is generated once and vault-encrypted.
              </p>
            )}
          </div>
          {!signingEnabled && (
            <Button
              variant="outline"
              size="sm"
              disabled={enableSigning.isPending || signing.isPending}
              onClick={() => enableSigning.mutate()}
            >
              {enableSigning.isPending ? 'Generating…' : 'Generate key'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
