import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AI_PROVIDERS, type AiProviderKind, type AiProviderView, type AiTestResult } from '@swarmy/core';
import { Badge, Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const HINTS: Record<AiProviderKind, string> = {
  anthropic: 'claude-* models',
  openai: 'gpt-*, o-series, embeddings',
  azure: 'your Azure OpenAI deployments',
  gemini: 'gemini-*, embeddings',
  bedrock: 'Nova, Titan embeddings, Claude on AWS',
  mistral: 'mistral-*, codestral, embeddings',
  groq: 'fast Llama / gpt-oss',
  openrouter: 'hundreds of models via vendor/model',
  ollama: 'open models on your own servers',
  vllm: 'GPU inference on your own servers',
  custom: 'any OpenAI-compatible base URL',
};

const URL_PLACEHOLDER: Partial<Record<AiProviderKind, string>> = {
  azure: 'https://<resource>.openai.azure.com',
  ollama: 'http://ollama:11434',
  vllm: 'http://vllm:8000',
  custom: 'https://llm.example.com',
};

/** One provider row: credential (write-only), base URL / region where needed, save + test. */
export function ProviderRow({
  kind,
  view,
}: {
  kind: AiProviderKind;
  view: AiProviderView | null;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const info = AI_PROVIDERS[kind];
  const [apiKey, setApiKey] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState(view?.discovered ? '' : (view?.baseUrl ?? ''));
  const [region, setRegion] = React.useState(view?.region ?? '');
  const [test, setTest] = React.useState<AiTestResult | null>(null);

  const save = useMutation(
    trpc.ai.setProvider.mutationOptions({
      onSuccess: () => {
        setApiKey('');
        toast.success(`${info.label} saved`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const runTest = useMutation(
    trpc.ai.testProvider.mutationOptions({
      onSuccess: (r) => setTest(r),
      onError: (e) => toast.error(e.message),
    }),
  );

  const needsUrl = !info.defaultBaseUrl && kind !== 'bedrock';
  const configured = Boolean(view?.hasKey);
  const discovered = view?.discovered ?? null;
  const urlChanged = baseUrl.trim() !== (view?.discovered ? '' : (view?.baseUrl ?? ''));
  const regionChanged = kind === 'bedrock' && region.trim() !== (view?.region ?? '');
  const canSave = apiKey.trim().length > 0 || (needsUrl && urlChanged) || regionChanged;

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">{info.label}</p>
        <span className="text-muted-foreground text-xs">{HINTS[kind]}</span>
        {discovered ? (
          <Badge variant="secondary" title="Found in your swarm — reached over the overlay, not the internet">
            in-cluster · {discovered.service}
          </Badge>
        ) : configured && info.needsKey ? (
          <Badge variant="secondary">key stored</Badge>
        ) : null}
        {view?.isDefault ? <Badge variant="outline">default</Badge> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {info.needsKey || kind === 'vllm' ? (
          <Input
            type="password"
            className="min-w-0 flex-1 basis-52"
            placeholder={configured && info.needsKey ? 'Replace credential…' : info.keyHint}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        ) : null}
        {needsUrl ? (
          <Input
            className="min-w-0 flex-1 basis-52"
            placeholder={discovered ? `${view?.baseUrl} (auto)` : URL_PLACEHOLDER[kind]}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        ) : null}
        {kind === 'bedrock' ? (
          <Input
            className="w-36"
            placeholder="us-east-1"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
          />
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!canSave || save.isPending}
          onClick={() =>
            save.mutate({
              kind,
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              ...(needsUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
              ...(kind === 'bedrock' && region.trim() ? { region: region.trim() } : {}),
              makeDefault: kind === 'custom',
            })
          }
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!view || !configured || runTest.isPending}
          onClick={() => {
            setTest(null);
            runTest.mutate({ kind });
          }}
        >
          {runTest.isPending ? 'Testing…' : 'Test'}
        </Button>
      </div>
      {test ? (
        <p className={test.ok ? 'text-tone-ok text-xs' : 'text-tone-bad text-xs'}>
          {test.ok
            ? `OK — answered in ${test.latencyMs}ms`
            : `Failed: ${test.message ?? 'unknown error'}`}
        </p>
      ) : null}
    </div>
  );
}
