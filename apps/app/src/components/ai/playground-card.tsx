import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FlaskConicalIcon } from 'lucide-react';
import type { AiPlaygroundResult } from '@swarmy/core';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Playground: try a model with one key's limits — its allowlist, budget and
 * rate limit apply, and the call is metered and traced like any app's. The
 * request runs server-side; no key ever reaches the browser.
 */
export function PlaygroundCard(): React.JSX.Element {
  const trpc = useTRPC();
  const keys = useQuery(trpc.ai.keys.queryOptions());
  const models = useQuery(trpc.ai.models.queryOptions());
  const [keyId, setKeyId] = React.useState('');
  const [model, setModel] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [result, setResult] = React.useState<AiPlaygroundResult | null>(null);

  const active = (keys.data ?? []).filter((k) => !k.disabled);
  const options = models.data?.models ?? [];
  const selectedKey = keyId || active[0]?.id || '';
  const selectedModel = model || options.find((m) => m.name === 'fast')?.name || options[0]?.name || '';
  const isEmbed = options.find((m) => m.name === selectedModel)?.kind === 'embed';

  const run = useMutation(
    trpc.ai.playground.mutationOptions({
      onSuccess: (r) => setResult(r),
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void => {
    if (!selectedKey || !selectedModel || !prompt.trim()) return;
    setResult(null);
    run.mutate(
      isEmbed
        ? { keyId: selectedKey, model: selectedModel, messages: [], input: prompt, maxTokens: 512 }
        : { keyId: selectedKey, model: selectedModel, messages: [{ role: 'user', content: prompt }], maxTokens: 512 },
    );
  };

  return (
    <div className="calm-card p-5">
      <div className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
          <FlaskConicalIcon className="size-5" />
        </span>
        <div>
          <p className="font-semibold">Playground</p>
          <p className="text-muted-foreground text-xs">
            Try a model under a key&apos;s limits. Metered and traced like any app call.
          </p>
        </div>
      </div>

      {active.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">Mint a key below to try a model.</p>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="pg-key" className="mono-label">Key</Label>
                <Select value={selectedKey} onValueChange={setKeyId}>
                  <SelectTrigger id="pg-key">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {active.map((k) => (
                      <SelectItem key={k.id} value={k.id}>
                        {k.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pg-model" className="mono-label">Model</Label>
                <Select value={selectedModel} onValueChange={setModel}>
                  <SelectTrigger id="pg-model">
                    <SelectValue placeholder={models.isPending ? 'Loading…' : 'Add a provider first'} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((m) => (
                      <SelectItem key={m.name} value={m.name}>
                        <span className="mono-data text-xs">{m.name}</span>
                        <span className="text-muted-foreground ml-2 text-[11px]">
                          {m.source === 'alias' ? `→ ${m.providers.join(', ')}` : m.kind === 'embed' ? 'embeddings' : ''}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Textarea
              rows={5}
              placeholder={isEmbed ? 'Text to embed…' : 'Ask something…'}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-[11px]">⌘↵ to run</span>
              <Button size="sm" variant="outline" onClick={submit} disabled={run.isPending || !prompt.trim() || !selectedModel}>
                {run.isPending ? 'Running…' : 'Run'}
              </Button>
            </div>
          </div>

          <div className="bg-muted/30 flex min-h-40 flex-col rounded-xl border p-4">
            {run.isPending ? (
              <div className="space-y-2">
                <div className="shimmer-line h-4 w-3/4 rounded" />
                <div className="shimmer-line h-4 w-1/2 rounded" />
              </div>
            ) : result ? (
              <>
                {result.error ? (
                  <p className="text-tone-bad text-sm">{result.error}</p>
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{result.text || '(empty reply)'}</p>
                )}
                {result.toolCalls.map((t, i) => (
                  <code key={i} className="mono-data mt-2 block text-xs">
                    {t.name}({t.arguments})
                  </code>
                ))}
                <div className="text-muted-foreground mt-auto flex flex-wrap gap-x-3 gap-y-1 pt-3 text-[11px]">
                  {result.provider ? (
                    <span className="mono-data">
                      {result.provider}/{result.model}
                    </span>
                  ) : null}
                  <span className="mono-data">
                    {result.inTokens}→{result.outTokens} tok
                  </span>
                  <span className="mono-data">${result.costUsd.toFixed(5)} est.</span>
                  <span className="mono-data">{result.latencyMs}ms</span>
                  {result.attempts.length > 1 ? (
                    <span title={result.attempts.map((a) => `${a.provider}/${a.model}: ${a.status ?? 'network'}`).join('\n')}>
                      {result.attempts.length} attempts (fallback)
                    </span>
                  ) : null}
                  {result.traceId ? <span className="mono-data">trace {result.traceId.slice(0, 12)}…</span> : null}
                </div>
              </>
            ) : (
              <p className="text-muted-foreground m-auto text-sm">The reply shows up here.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
