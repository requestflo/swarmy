import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { checkCorsOrigin, type BucketCorsView, type CorsMethod } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { MAX_AGE_OPTIONS } from './cors-model';

const ageValue = (s: number | null) => MAX_AGE_OPTIONS.find((o) => o.seconds === s)?.value ?? '3600';

/**
 * The browser rules being edited: origins, methods, preflight cache, and the
 * save. Starts from what Garage holds; a fresh bucket starts at GET · HEAD,
 * cached an hour. Key the caller by the stored rules so a save resets it.
 */
export function useCorsDraft(v: BucketCorsView) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [origins, setOrigins] = React.useState(v.origins);
  const [methods, setMethods] = React.useState<CorsMethod[]>(v.origins.length ? (v.methods as CorsMethod[]) : ['GET', 'HEAD']);
  const [age, setAge] = React.useState(ageValue(v.origins.length ? v.maxAgeSeconds : 3600));
  const save = useMutation(
    trpc.buckets.setCors.mutationOptions({
      onSuccess: (r) => {
        const n = r.origins.length;
        toast.success(n ? `${r.bucket}: ${n} site${n === 1 ? '' : 's'} can fetch it directly` : `${r.bucket}: no website fetches it directly now`);
        void qc.invalidateQueries({ queryKey: trpc.buckets.getCors.queryKey({ bucketId: v.bucketId }) });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const seconds = MAX_AGE_OPTIONS.find((o) => o.value === age)?.seconds ?? null;
  return {
    origins,
    methods,
    age,
    setAge,
    saving: save.isPending,
    dirty: origins.join() !== v.origins.join() || (origins.length > 0 && (methods.join() !== v.methods.join() || seconds !== v.maxAgeSeconds)),
    /** Add one origin; returns why it was refused, or null. */
    add(raw: string): string | null {
      const check = checkCorsOrigin(raw, { wildcards: v.wildcards });
      if (!check.ok) return check.reason;
      if (!origins.includes(check.origin)) setOrigins([...origins, check.origin]);
      return null;
    },
    remove: (o: string) => setOrigins(origins.filter((x) => x !== o)),
    toggle: (m: CorsMethod) => setMethods(methods.includes(m) ? methods.filter((x) => x !== m) : [...methods, m]),
    save: () => save.mutate({ bucketId: v.bucketId, origins, methods, maxAgeSeconds: seconds }),
  };
}

export type CorsDraft = ReturnType<typeof useCorsDraft>;
