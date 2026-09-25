import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlugZapIcon } from 'lucide-react';
import { AI_PROVIDER_KINDS } from '@swarmy/core';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, CopyButton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ProviderRow } from './provider-row';

/**
 * Providers card: configured and in-cluster providers first, every other
 * provider one click away. Keys are write-only — the server stores them
 * encrypted and never returns them; a row only shows *that* a key exists.
 * Ollama / vLLM deployed from the templates appear on their own.
 */
export function ProvidersCard(): React.JSX.Element {
  const trpc = useTRPC();
  const providers = useQuery({ ...trpc.ai.providers.queryOptions(), refetchInterval: 15_000 });

  const byKind = new Map((providers.data?.providers ?? []).map((p) => [p.kind, p]));
  const gatewayUrl = providers.data?.gatewayUrl ?? '';
  const [more, setMore] = React.useState(false);
  const active = AI_PROVIDER_KINDS.filter((k) => byKind.has(k));
  const rest = AI_PROVIDER_KINDS.filter((k) => !byKind.has(k));

  return (
    <div className="calm-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <PlugZapIcon className="size-5" />
          </span>
          <div>
            <p className="font-semibold">Providers</p>
            <p className="text-muted-foreground text-xs">
              Paste a provider API key once — apps never see it.
            </p>
          </div>
        </div>
        {gatewayUrl ? (
          <div className="bg-muted/40 flex items-center gap-2 rounded-md px-3 py-1.5">
            <span className="mono-label text-muted-foreground !mb-0 !text-[10px]">Gateway</span>
            <code className="mono-data max-w-[220px] truncate text-xs">{gatewayUrl}</code>
            <CopyButton value={gatewayUrl} />
          </div>
        ) : null}
      </div>

      {providers.isLoading ? (
        <div className="mt-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-14 rounded-lg" />
          ))}
        </div>
      ) : providers.isError ? (
        <p className="text-tone-bad mt-4 text-sm">
          Couldn&apos;t load providers: {providers.error.message}
        </p>
      ) : (
        <>
          <div className="divide-border mt-3 divide-y">
            {active.map((kind) => (
              <ProviderRow key={kind} kind={kind} view={byKind.get(kind) ?? null} />
            ))}
          </div>
          {rest.length ? (
            <Collapsible open={more || active.length === 0} onOpenChange={setMore}>
              {active.length > 0 ? (
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="mt-2">
                    {more ? 'Hide other providers' : `Add a provider (${rest.length} more)`}
                  </Button>
                </CollapsibleTrigger>
              ) : null}
              <CollapsibleContent>
                <div className="divide-border divide-y border-t">
                  {rest.map((kind) => (
                    <ProviderRow key={kind} kind={kind} view={null} />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </>
      )}
    </div>
  );
}
