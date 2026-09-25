import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Input, Label, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Gateway toggles: request audit log, response cache, and the log guardrails. */
export function SettingsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const settings = useQuery({ ...trpc.ai.settings.queryOptions(), refetchInterval: 15_000 });
  const save = useMutation(
    trpc.ai.setSettings.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  const s = settings.data;
  const [cap, setCap] = React.useState<string | null>(null);
  const capValue = cap ?? (s?.guardrails.maxPromptTokens ? String(s.guardrails.maxPromptTokens) : '');
  const saveCap = (): void => {
    if (cap === null) return;
    const n = Number(cap);
    save.mutate({ guardrails: { maxPromptTokens: cap.trim() && n > 0 ? Math.floor(n) : null } });
    setCap(null);
  };

  return (
    <div className="calm-card p-5">
      <p className="font-semibold">Gateway settings</p>
      <p className="text-muted-foreground text-xs">Applies to every request through the gateway.</p>

      {settings.isLoading || !s ? (
        <div className="mt-4 space-y-3">
          <div className="shimmer-line h-10 rounded-lg" />
          <div className="shimmer-line h-10 rounded-lg" />
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">Request audit log</Label>
              <p className="text-muted-foreground text-xs">
                Store one row per request with a redacted (200-char) prompt.
              </p>
            </div>
            <Switch
              checked={s.auditLog}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate({ auditLog: v })}
            />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">Response cache</Label>
              <p className="text-muted-foreground text-xs">
                Serve identical non-streaming requests from a 5-minute cache — repeated calls cost
                nothing.
              </p>
            </div>
            <Switch
              checked={s.cache}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate({ cache: v })}
            />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">Redact personal data</Label>
              <p className="text-muted-foreground text-xs">
                Emails, phone and card numbers, keys and IPs are masked before a prompt is logged.
              </p>
            </div>
            <Switch
              checked={s.guardrails.redactPii}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate({ guardrails: { redactPii: v } })}
            />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label htmlFor="ai-prompt-cap" className="text-sm font-medium">
                Prompt size cap
              </Label>
              <p className="text-muted-foreground text-xs">
                Refuse prompts above this many tokens (estimated). Empty = no cap.
              </p>
            </div>
            <Input
              id="ai-prompt-cap"
              type="number"
              min={1}
              className="w-28"
              placeholder="none"
              value={capValue}
              onChange={(e) => setCap(e.target.value)}
              onBlur={saveCap}
              onKeyDown={(e) => e.key === 'Enter' && saveCap()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
