import { useQuery } from '@tanstack/react-query';
import type { PublicStatusView, StatusPageView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/**
 * The org's status pages and the snapshot of one of them (by slug, else the
 * first live page) — the same `publicStatus` the public JSON route serves,
 * read through the authed `statusPages.preview`.
 */
export function useStatusSnapshot(slug?: string): {
  pages: StatusPageView[] | undefined;
  page: StatusPageView | undefined;
  snapshot: PublicStatusView | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
} {
  const trpc = useTRPC();
  const pages = useQuery({ ...trpc.statusPages.list.queryOptions(), refetchInterval: 15_000 });
  const list = pages.data;
  const page = list?.find((p) => p.slug === slug) ?? list?.find((p) => p.enabled) ?? list?.[0];
  const snap = useQuery({
    ...trpc.statusPages.preview.queryOptions({ slug: page?.slug ?? 'none' }),
    enabled: Boolean(page?.enabled),
    refetchInterval: 15_000,
  });
  return {
    pages: list,
    page,
    snapshot: page?.enabled ? snap.data : undefined,
    isLoading: pages.isLoading || (Boolean(page?.enabled) && snap.isLoading),
    error: pages.error ?? snap.error ?? null,
    refetch: () => {
      void pages.refetch();
      void snap.refetch();
    },
  };
}
