import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { useAwaitNode } from './use-await-node';
import { OsPicker } from './os-picker';
import { MintTokenForm } from './mint-token-form';
import { InstallCommandPanel } from './install-command-panel';
import type { NodeRoleChoice } from './node-role-picker';

/**
 * Hot Signal "Add a node" guided flow: mint a token, copy the one-liner, then
 * watch the node connect live. Owns the form state + join-token mutation; the
 * presentation is split across focused sub-components.
 */
export function AddNodeFlow(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [token, setToken] = React.useState<string | null>(null);
  const [mesh, setMesh] = React.useState<{ setupKey: string; managementUrl?: string; driver?: string } | null>(
    null,
  );
  const [label, setLabel] = React.useState('');
  const [nodeLabels, setNodeLabels] = React.useState('');
  const [role, setRole] = React.useState<NodeRoleChoice>('auto');

  const arrived = useAwaitNode(token !== null);

  const generate = useMutation(
    trpc.nodes.generateJoinToken.mutationOptions({
      onSuccess: (res) => {
        setToken(res.token);
        setMesh(
          res.meshSetupKey
            ? { setupKey: res.meshSetupKey, managementUrl: res.meshManagementUrl, driver: res.meshDriver }
            : null,
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="grid gap-6">
      <OsPicker />

      {token === null ? (
        <MintTokenForm
          role={role}
          onRoleChange={setRole}
          label={label}
          onLabelChange={setLabel}
          nodeLabels={nodeLabels}
          onNodeLabelsChange={setNodeLabels}
          onSubmit={() => generate.mutate({ label: label || undefined })}
          pending={generate.isPending}
        />
      ) : (
        <InstallCommandPanel token={token} labels={nodeLabels} role={role} mesh={mesh} arrived={arrived} />
      )}
    </div>
  );
}
