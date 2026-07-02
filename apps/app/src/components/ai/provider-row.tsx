import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AiProviderKind, AiProviderView, AiTestResult } from '@swarmy/core';
import { Badge, Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const TITLES: Record<AiProviderKind, { label: string; hint: string }> = {
  anthropic: { label: 'Anthropic', hint: 'claude-* models' },
  openai: { label: 'OpenAI', hint: 'gpt-*, o-series, embeddings' },
  custom: { label: 'Custom', hint: 'any OpenAI-compatible base URL' },
};

/** One provider row: key field (write-only), base URL (custom), save/test. */
export function ProviderRow({
  kind,
  view,
}: {
  kind: AiProviderKind;
  view: AiProviderView | null;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [apiKey, setApiKey] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState(view?.baseUrl ?? '');
  const [test, setTest] = React.useState<AiTestResult | null>(null);

  const save = useMutation(
    trpc.ai.setProvider.mutationOptions({
      onSuccess: () => {
        setApiKey('');
        toast.success(`${TITLES[kind].label} saved`);
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

  const configured = Boolean(view?.hasKey);
  const canSave = apiKey.trim().length > 0 || (kind === 'custom' && baseUrl.trim() !== (view?.baseUrl ?? ''));

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">{TITLES[kind].label}</p>
        <span className="text-muted-foreground text-xs">{TITLES[kind].hint}</span>
        {configured ? <Badge variant="secondary">key stored</Badge> : null}
        {view?.isDefault ? <Badge>default</Badge> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          className="min-w-0 flex-1 basis-52"
          placeholder={configured ? 'Replace API key…' : 'Paste API key…'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {kind === 'custom' ? (
          <Input
            className="min-w-0 flex-1 basis-52"
            placeholder="https://llm.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
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
              ...(kind === 'custom' && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
              makeDefault: kind === 'custom',
            })
          }
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!configured || runTest.isPending}
          onClick={() => {
            setTest(null);
            runTest.mutate({ kind });
          }}
        >
          {runTest.isPending ? 'Testing…' : 'Test'}
        </Button>
      </div>
      {test ? (
        <p className={test.ok ? 'text-status-online text-xs' : 'text-status-offline text-xs'}>
          {test.ok
            ? `OK — ${test.target} answered in ${test.latencyMs}ms`
            : `Failed (${test.target}): ${test.message ?? 'unknown error'}`}
        </p>
      ) : null}
    </div>
  );
}
