import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Say } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { ExposureSection } from '@/components/exposure/exposure-page';
import { DecisionsFeed } from './decisions-feed';
import { RulesList } from './rules-list';
import { SafetyModeCard, SafetyModeNext } from './safety-mode-card';
import { StackEnvCard } from './stack-env-card';

/** Settings → Guardrails: the rules every deploy is checked against, as Block · Warn · Off, and what they stopped. */
export function GuardrailsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const config = useQuery({ ...trpc.guardrails.config.queryOptions(), refetchInterval: 15_000 });
  const decisions = useQuery({ ...trpc.guardrails.recentDecisions.queryOptions({ limit: 30 }), refetchInterval: 15_000 });
  const envs = useQuery(trpc.guardrails.stackEnvs.queryOptions());
  const c = config.data;
  const on = c?.rules.filter((r) => r.enabled) ?? [];
  const blocking = on.filter((r) => r.severity === 'block').length;
  const since = Date.now() - 30 * 86_400_000;
  const stopped = (decisions.data ?? []).filter((d) => d.kind === 'blocked' && new Date(d.at).getTime() >= since).length;

  const title = !c ? (
    'Guardrails.'
  ) : (
    <>
      {plural(blocking, 'rule')} block, {on.length - blocking} warn.{' '}
      {decisions.data ? (stopped ? <Say tone="ok">Last 30 days they stopped {plural(stopped, 'deploy')}.</Say> : <em>Nothing stopped in 30 days.</em>) : null}
    </>
  );
  const code = c
    ? [
        { label: 'guardrails', code: JSON.stringify(c, null, 2) },
        { label: 'labels', code: (envs.data ?? []).map((s) => `${s.stack.padEnd(18)} ${s.production ? 'swarmy.env=production' : '(no swarmy.env)'}`).join('\n') || '# no apps yet' },
      ]
    : [];

  return (
    <RowPage
      title={title}
      description={c?.productionSafetyMode ? 'Production is locked down: every rule blocks there. Each rule below also sets what happens everywhere else.' : 'Checked on every deploy, by anyone. Production is an app labelled production.'}
      aside={
        <>
          {c ? <CodeView title="Guardrails as code" tabs={code} source="readonly" /> : null}
          <DecisionsFeed />
          <StackEnvCard />
        </>
      }
    >
      {config.isLoading ? (
        <SkeletonBody variant="list" />
      ) : config.isError ? (
        <ErrorState title="Couldn’t load your guardrails." error={config.error} retry={() => void config.refetch()} />
      ) : c ? (
        <>
          <SafetyModeNext config={c} />
          <RulesList config={c} decisions={decisions.data ?? []} />
          <SafetyModeCard config={c} />
        </>
      ) : null}
      <ExposureSection />
    </RowPage>
  );
}
