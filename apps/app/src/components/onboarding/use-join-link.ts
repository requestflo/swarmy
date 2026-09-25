import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { InstallTarget, MeshSetupKey } from './install-command-panel';

export interface JoinLink {
  token: string;
  expiresAt: Date;
  target: InstallTarget | null;
  mesh: MeshSetupKey | null;
}

/**
 * The Add-a-server join link: minted once when the page opens (a single-use
 * token that expires in an hour), and again on demand with a label.
 */
export function useJoinLink(): {
  link: JoinLink | null;
  pending: boolean;
  failed: boolean;
  mint: (label?: string) => void;
} {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [link, setLink] = React.useState<JoinLink | null>(null);
  const [busy, setBusy] = React.useState(false);
  const generate = useMutation(
    trpc.nodes.generateJoinToken.mutationOptions({
      onSuccess: (res) => {
        setLink({
          token: res.token,
          expiresAt: new Date(res.expiresAt),
          target: res.install ?? null,
          mesh: res.meshSetupKey
            ? { setupKey: res.meshSetupKey, managementUrl: res.meshManagementUrl, driver: res.meshDriver }
            : null,
        });
        void qc.invalidateQueries({ queryKey: trpc.nodes.listJoinTokens.queryKey() });
      },
      onError: (e) => toast.error(e.message),
      onSettled: () => setBusy(false),
    }),
  );
  const mint = React.useCallback(
    (label?: string) => {
      setBusy(true);
      generate.mutate({ label: label?.trim() || undefined });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // One link per visit (the ref survives StrictMode's double effect).
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    mint();
  }, [mint]);
  return { link, pending: busy, failed: generate.isError && !link && !busy, mint };
}
