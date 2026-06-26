import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster, TooltipProvider } from '@swarmy/ui';
import { createQueryClient, createTrpcClient, TRPCProvider } from '@/integrations/trpc';

const queryClient = createQueryClient();
const trpcClient = createTrpcClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </TRPCProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
