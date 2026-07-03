import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SparklesIcon } from 'lucide-react';
import { StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { KeyRevealBanner } from '@/components/ai/key-reveal-banner';
import { StackAiGrantForm } from './stack-ai-grant-form';
import { StackAiGranted } from './stack-ai-granted';

interface StackAiAccessCardProps {
  stack: string;
}

/**
 * AI gateway access for one stack: the stack-tagged virtual key, the services
 * wired through the gateway, grant/rotate/revoke — all inline. A fresh key is
 * revealed ONCE via the coral banner at the top of the card.
 */
export function StackAiAccessCard({ stack }: StackAiAccessCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const access = useQuery({ ...trpc.ai.stackAccess.queryOptions({ stack }), refetchInterval: 5_000 });
  const [reveal, setReveal] = React.useState<{ key: string; gatewayUrl: string } | null>(null);

  const a = access.data;
  const granted = Boolean(a?.key);

  return (
    <section className="card-pop p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <SparklesIcon className="size-5" />
          </span>
          <div>
            <p className="font-semibold">AI gateway access</p>
            <p className="text-muted-foreground text-xs">
              One revocable key per stack — provider keys never leave the controller.
            </p>
          </div>
        </div>
        <StatusBadge tone={granted ? 'online' : 'neutral'} label={granted ? 'granted' : 'not granted'} />
      </div>

      {reveal ? (
        <div className="mt-4">
          <KeyRevealBanner
            keyValue={reveal.key}
            gatewayUrl={reveal.gatewayUrl}
            onDismiss={() => setReveal(null)}
          />
        </div>
      ) : null}

      {access.isLoading ? (
        <div className="mt-4 space-y-2">
          <div className="shimmer-line h-10 rounded-lg" />
          <div className="shimmer-line h-10 rounded-lg" />
        </div>
      ) : access.isError ? (
        <p className="text-status-offline mt-4 text-sm">{access.error.message}</p>
      ) : a && a.key ? (
        <StackAiGranted
          stack={stack}
          keyName={a.key.name}
          createdAt={a.key.createdAt}
          attachedServices={a.attachedServices}
        />
      ) : (
        <p className="text-muted-foreground mt-4 text-sm">
          No AI access yet. Grant it and every app in {stack} can call Claude, GPT and friends
          through your gateway — with usage, cost and rate limits landing on the AI page.
        </p>
      )}

      {!access.isLoading && !access.isError ? (
        <div className="mt-4">
          <StackAiGrantForm stack={stack} hasGrant={granted} onGranted={setReveal} />
        </div>
      ) : null}
    </section>
  );
}
