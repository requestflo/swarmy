import * as React from 'react';
import { Button } from '@swarmy/ui';
import { CalmPage, Depth, Say, SayHeader, Section } from '@/components/calm';
import { GitHerokuSteps } from '@/components/ci/git-heroku-steps';
import { HerokuCopyData } from './heroku-copy-data';
import { HerokuDeployAside } from './heroku-deploy-aside';
import { HerokuDeployResultView } from './heroku-deploy-result';
import { HerokuImportAside } from './heroku-import-aside';
import { HerokuPlanReview } from './heroku-plan-review';
import { HerokuSourceForm } from './heroku-source-form';
import { useHerokuImport } from './use-heroku-import';

/**
 * Deploy › Import from Heroku: which app (a token, or the files pasted in) →
 * the plan in plain words → Deploy (the data stores and sealed secrets; the
 * services deploy when swarmy.yaml is pushed) → copy the data, its own
 * explicit step. Nothing on Heroku changes at any point.
 */
export function HerokuImportPage(): React.JSX.Element {
  const h = useHerokuImport();
  const v = h.view;
  const errors = v?.issues.filter((i) => i.severity === 'error') ?? [];
  const copyable = v?.plan.data.filter((d) => d.kind === 'postgres' && v.copyable.includes(d.name)) ?? [];

  return (
    <CalmPage
      crumbs={[{ label: 'Overview', to: '/overview' }, { label: 'deploy', to: '/deploy' }, { label: 'heroku' }]}
      actions={
        v ? (
          <Button variant="ghost" size="sm" onClick={h.restart} className="pointer-coarse:min-h-11">
            Import another app
          </Button>
        ) : null
      }
      aside={v ? <HerokuDeployAside h={h} /> : <HerokuImportAside />}
    >
      <SayHeader
        eyebrow={v ? `Heroku · ${v.herokuApp}` : 'Import from Heroku'}
        title={v ? v.plan.headline : 'Bring a Heroku app across.'}
        lede={
          v ? (
            h.deployed ? (
              <>The data stores and secrets are set up. <Say tone="info">The code comes next.</Say></>
            ) : (
              'Nothing has run yet. Read it through, then Deploy.'
            )
          ) : (
            'swarmy reads the app — processes, add-ons, config vars, domains — and shows what each becomes before anything runs.'
          )
        }
      />
      {!v ? <HerokuSourceForm h={h} /> : null}
      {errors.length ? (
        <Section title="Needs a fix before it deploys" count={errors.length}>
          <ul className="text-tone-bad flex flex-col gap-1 text-[13px]">
            {errors.map((e) => (
              <li key={`${e.line}:${e.message}`}>{e.line ? `line ${e.line}: ` : ''}{e.message}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      {h.deployed ? <HerokuDeployResultView result={h.deployed} /> : null}
      {h.deployed && h.source
        ? copyable.map((d) => <HerokuCopyData key={d.name} source={h.source!} stack={h.deployed!.stack} cluster={d.name} envVar={d.envVar} />)
        : null}
      {v ? <HerokuPlanReview view={v} /> : null}
      {v && (v.steps.data.length || v.steps.config.length) ? (
        <Depth at={copyable.length ? 'controls' : 'summary'}>
          <section className="calm-card px-5 py-4">
            <GitHerokuSteps data={v.steps.data} config={v.steps.config} />
          </section>
        </Depth>
      ) : null}
    </CalmPage>
  );
}
