import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { InstallTarget, MeshSetupKey } from './install-command-panel';

export interface JoinLink {
  id: string;
  token: string;
  expiresAt: Date;
  target: InstallTarget | null;
  mesh: MeshSetupKey | null;
}

/** Reuse a link only while it has this long left, so a paste doesn't race expiry. */
const REUSE_MARGIN_MS = 5 * 60_000;

/**
 * The last link minted in this tab. The plaintext token only exists at mint
 * time, so it lives in memory (never browser storage) and is reused while the
 * server still lists it as active and it has time left.
 */
let lastLink: JoinLink | null = null;

/**
 * The Add-a-server join link. Visiting the page mints nothing: the person
 * clicks "Create join link" (or "New link" at Controls). An unexpired, unused
 * link from earlier in this tab comes back instead of a new one.
 */
export function useJoinLink(): {
  link: JoinLink | null;
  pending: boolean;
  failed: boolean;
  mint: (label?: string) => void;
} {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const tokens = useQuery({ ...trpc.nodes.listJoinTokens.queryOptions(), enabled: lastLink !== null });
  const [minted, setMinted] = React.useState<JoinLink | null>(null);
  const [busy, setBusy] = React.useState(false);
  const generate = useMutation(
    trpc.nodes.generateJoinToken.mutationOptions({
      onSuccess: (res) => {
        const next: JoinLink = {
          id: res.id,
          token: res.token,
          expiresAt: new Date(res.expiresAt),
          target: res.install ?? null,
          mesh: res.meshSetupKey
            ? { setupKey: res.meshSetupKey, managementUrl: res.meshManagementUrl, driver: res.meshDriver }
            : null,
        };
        lastLink = next;
        setMinted(next);
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
  const reused = React.useMemo(() => {
    const prev = lastLink;
    if (!prev || prev.expiresAt.getTime() - Date.now() < REUSE_MARGIN_MS) return null;
    const row = tokens.data?.find((t) => t.id === prev.id);
    return row?.status === 'active' ? prev : null;
  }, [tokens.data]);
  const link = minted ?? reused;
  return { link, pending: busy || (lastLink !== null && tokens.isLoading), failed: generate.isError && !link && !busy, mint };
}
