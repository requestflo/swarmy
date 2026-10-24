import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPCClient } from '@/integrations/trpc';
import type { BundleProgressLike } from './bundle-words';

export type BundleState = (BundleProgressLike & { name: string }) | null;

/** A slice of the file as base64 (the browser's own encoder: fast, no huge strings in JS). */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.readAsDataURL(blob);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send an offline bundle to the controller in chunks (`platform.bundle.*`),
 * then follow the load until it is done or failed. A chunk that fails is
 * retried from the byte the controller says it has.
 */
export function useBundleUpload(): { state: BundleState; busy: boolean; start: (file: File) => Promise<void> } {
  const client = useTRPCClient();
  const qc = useQueryClient();
  const [state, setState] = React.useState<BundleState>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = React.useCallback(
    async (file: File) => {
      const fail = (error: string) => setState((s) => ({ ...(s ?? { name: file.name, size: file.size, received: 0 }), phase: 'failed', error }));
      try {
        const u = await client.platform.bundle.begin.mutate({ name: file.name, size: file.size });
        setState({ name: file.name, phase: 'sending', size: file.size, received: 0 });
        let offset = 0;
        let tries = 0;
        while (offset < file.size && alive.current) {
          const data = await base64Of(file.slice(offset, offset + u.chunkBytes));
          try {
            offset = (await client.platform.bundle.chunk.mutate({ id: u.id, offset, data })).received;
            tries = 0;
          } catch (e) {
            if (++tries > 3) throw e;
            await sleep(1_000 * tries);
            offset = (await client.platform.bundle.status.query({ id: u.id })).received;
          }
          setState((s) => (s ? { ...s, received: offset } : s));
        }
        if (!alive.current) return;
        let v = await client.platform.bundle.finish.mutate({ id: u.id });
        while (v.phase === 'loading' && alive.current) {
          setState((s) => ({ ...v, name: s?.name ?? file.name }));
          await sleep(2_000);
          v = await client.platform.bundle.status.query({ id: u.id });
        }
        setState((s) => ({ ...v, name: s?.name ?? file.name }));
        if (v.phase === 'done') void qc.invalidateQueries();
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
    [client, qc],
  );

  const busy = state?.phase === 'sending' || state?.phase === 'loading';
  return { state, busy, start };
}
