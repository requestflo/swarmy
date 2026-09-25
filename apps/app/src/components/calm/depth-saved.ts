import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { DepthName } from './depth';

/**
 * The person's saved default depth. The server (`org.myPreferences`) is the
 * source of truth, so the choice follows them across browsers; localStorage
 * (`swarmy-depth:<userId>`) is the cache that paints the first frame before
 * the query answers. A choice made before it was saved server-side is
 * carried up once.
 */
const BASE_KEY = 'swarmy-depth';

function isDepth(v: unknown): v is DepthName {
  return v === 'summary' || v === 'controls' || v === 'code';
}

function readStored(userId: string | null): DepthName | null {
  try {
    const own = userId ? window.localStorage.getItem(`${BASE_KEY}:${userId}`) : null;
    const v = own ?? window.localStorage.getItem(BASE_KEY);
    return isDepth(v) ? v : null;
  } catch {
    return null;
  }
}

function writeStored(userId: string | null, d: DepthName): void {
  try {
    if (userId) window.localStorage.setItem(`${BASE_KEY}:${userId}`, d);
    window.localStorage.setItem(BASE_KEY, d);
  } catch {
    // storage unavailable — the choice lasts for this tab only
  }
}

export function useSavedDepth(): { userId: string | null; stored: DepthName | null; save: (d: DepthName) => void } {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const whoami = useQuery(trpc.org.whoami.queryOptions());
  const userId = whoami.data?.userId ?? null;
  const prefs = useQuery({ ...trpc.org.myPreferences.queryOptions(), enabled: userId !== null, staleTime: 5 * 60_000 });
  const mutation = useMutation(
    trpc.org.setMyPreferences.mutationOptions({
      onSuccess: (res) => qc.setQueryData(trpc.org.myPreferences.queryKey(), res),
    }),
  );
  const { mutate } = mutation;
  const [stored, setStored] = React.useState<DepthName | null>(() => readStored(null));
  React.useEffect(() => {
    if (userId) setStored(readStored(userId));
  }, [userId]);

  const server = prefs.data?.depth ?? null;
  const pushed = React.useRef(false);
  React.useEffect(() => {
    if (!userId || !prefs.isSuccess) return;
    if (server) {
      writeStored(userId, server);
      setStored(server);
      return;
    }
    const local = readStored(userId);
    if (local && !pushed.current) {
      pushed.current = true;
      mutate({ depth: local });
    }
  }, [userId, prefs.isSuccess, server, mutate]);

  const save = React.useCallback(
    (d: DepthName) => {
      writeStored(userId, d);
      setStored(d);
      if (userId) mutate({ depth: d });
    },
    [userId, mutate],
  );
  return { userId, stored, save };
}
