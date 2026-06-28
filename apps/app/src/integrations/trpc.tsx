import { QueryClient } from '@tanstack/react-query';
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import superjson from 'superjson';
import type { AppRouter } from '@swarmy/trpc';
import { isDemo } from '@/demo/is-demo';
import { demoLink } from '@/demo/demo-link';

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

const TRPC_URL = '/api/trpc';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });
}

export function createTrpcClient() {
  // Demo mode: resolve everything from the in-memory store, no network/DB/auth.
  if (isDemo()) {
    return createTRPCClient<AppRouter>({ links: [demoLink()] });
  }
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({ url: TRPC_URL, transformer: superjson }),
        false: httpBatchLink({ url: TRPC_URL, transformer: superjson }),
      }),
    ],
  });
}
