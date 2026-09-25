import * as React from 'react';
import { AI_PROVIDERS, type AiKeyView, type AiProviderView, type AiUsageSummaryView } from '@swarmy/core';
import { CalmRow, RowList, Section } from '@/components/calm';

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Providers in one sentence each: ready or missing its key, where it runs. */
export function ProviderRows({ providers }: { providers: AiProviderView[] }): React.JSX.Element {
  const ready = providers.filter((p) => p.hasKey || p.inCluster);
  return (
    <Section title="Providers" count={`${ready.length} ready`} flush>
      <RowList label="AI providers">
        {providers.map((p) => {
          const ok = p.hasKey || p.inCluster;
          return (
            <CalmRow
              key={p.kind}
              tone={ok ? 'ok' : 'idle'}
              name={AI_PROVIDERS[p.kind]?.label ?? p.kind}
              sub={p.inCluster ? 'on your servers' : 'in the cloud'}
              say={
                ok
                  ? `${p.inCluster ? 'Runs on your own servers' : 'Key kept by swarmy, never shown to apps'}${p.isDefault ? ' · answers anything not named' : ''}`
                  : 'No key yet'
              }
              tech={p.baseUrl ?? AI_PROVIDERS[p.kind]?.defaultBaseUrl ?? ''}
              word={ok ? 'Online' : 'Idle'}
            />
          );
        })}
      </RowList>
    </Section>
  );
}

/** Where the money went: the top models over the window. */
export function UsageRows({ usage }: { usage: AiUsageSummaryView }): React.JSX.Element {
  const rows = [...usage.byModel].sort((a, b) => b.costUsd - a.costUsd).slice(0, 5);
  return (
    <Section title="Where it went" hint={`last ${usage.days.length} days · estimated`} flush>
      {rows.length === 0 ? (
        <p className="text-muted-foreground pb-3 text-[13px]">No requests yet.</p>
      ) : (
        <RowList label="Usage by model">
          {rows.map((r) => (
            <CalmRow
              key={r.key}
              tone="info"
              name={<span className="font-mono text-[13px]">{r.key}</span>}
              say={`${r.requests.toLocaleString()} requests`}
              tech={`${r.inTokens.toLocaleString()} in · ${r.outTokens.toLocaleString()} out`}
              word={usd(r.costUsd)}
              wordTone="idle"
            />
          ))}
        </RowList>
      )}
    </Section>
  );
}

/** Each app's key: its limits in words and what it spent. */
export function KeyRows({ keys }: { keys: AiKeyView[] }): React.JSX.Element {
  return (
    <Section title="App keys" count={keys.length} flush>
      <RowList label="Virtual keys">
        {keys.map((k) => (
          <CalmRow
            key={k.id}
            tone={k.disabled ? 'idle' : 'ok'}
            name={k.name}
            sub={k.appRef ?? 'not tied to an app'}
            say={[
              k.limits.dailyBudgetUsd ? `up to ${usd(k.limits.dailyBudgetUsd)} a day` : 'no daily limit',
              k.limits.models?.length ? `only ${k.limits.models.join(', ')}` : 'any model',
            ].join(' · ')}
            tech={`rpm ${k.limits.rpm ?? '∞'} · ${k.usage30d.requests.toLocaleString()} req / 30d`}
            word={k.disabled ? 'Revoked' : usd(k.usage30d.costUsd)}
            wordTone="idle"
          />
        ))}
      </RowList>
    </Section>
  );
}
