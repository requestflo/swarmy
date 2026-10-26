import * as React from 'react';
import { Button, Input, Label, Textarea } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { GitSegmented } from '@/components/ci/git-segmented';
import { HEROKU_SAMPLE } from './heroku-import-model';
import type { HerokuSourceDraft, HerokuSourceKind } from './heroku-types';
import type { HerokuImport } from './use-heroku-import';

const WAYS: ReadonlyArray<{ value: HerokuSourceKind; label: string }> = [
  { value: 'api', label: 'With a Heroku token' },
  { value: 'paste', label: 'Paste the files' },
];

function Field({ id, label, hint, children }: { id: string; label: string; hint?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-[13px] font-semibold">
        {label}
      </Label>
      {children}
      {hint ? <span className="text-muted-foreground text-[12px] leading-snug">{hint}</span> : null}
    </div>
  );
}

const PASTES: ReadonlyArray<{ key: keyof HerokuSourceDraft; label: string; hint: string; rows: number }> = [
  { key: 'procfile', label: 'Procfile', hint: 'web, worker, release… each becomes a service or the pre-deploy step.', rows: 4 },
  { key: 'appJson', label: 'app.json', hint: 'Formation, add-ons and buildpacks. Optional.', rows: 7 },
  { key: 'config', label: 'heroku config -s', hint: 'Secret-looking values are sealed, never written to swarmy.yaml.', rows: 5 },
  { key: 'domains', label: 'heroku domains', hint: 'Optional: one hostname per line works too.', rows: 2 },
];

/** Step 1: how swarmy reads the app — a token (read once, never kept) or the files pasted in. */
export function HerokuSourceForm({ h }: { h: HerokuImport }): React.JSX.Element {
  const d = h.draft;
  return (
    <Section title="Which Heroku app?" hint="nothing on Heroku changes">
      <GitSegmented value={d.kind} options={WAYS} onChange={(k) => h.setField('kind', k)} />
      {d.kind === 'api' ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="heroku-app" label="App name" hint="As in heroku apps, or the dashboard URL.">
            <Input id="heroku-app" value={d.app} onChange={(e) => h.setField('app', e.target.value)} placeholder="acme-shop" autoComplete="off" spellCheck={false} />
          </Field>
          <Field id="heroku-token" label="API token" hint={<>Run <span className="font-mono">heroku auth:token</span>. swarmy reads with it once and doesn’t keep it.</>}>
            <Input id="heroku-token" type="password" value={d.token} onChange={(e) => h.setField('token', e.target.value)} placeholder="HRKU-…" autoComplete="off" spellCheck={false} />
          </Field>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {PASTES.map((p) => (
            <Field key={p.key} id={`heroku-${p.key}`} label={p.label} hint={p.hint}>
              <Textarea
                id={`heroku-${p.key}`}
                rows={p.rows}
                value={d[p.key]}
                onChange={(e) => h.setField(p.key, e.target.value)}
                spellCheck={false}
                className="font-mono text-[12px]"
              />
            </Field>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button onClick={h.review} disabled={h.reviewing} className="pointer-coarse:min-h-11">
          {h.reviewing ? 'Reading the app…' : 'Review the plan'}
        </Button>
        {d.kind === 'paste' ? (
          <Button variant="ghost" size="sm" onClick={() => h.fill(HEROKU_SAMPLE)} className="pointer-coarse:min-h-11">
            Use a sample app
          </Button>
        ) : null}
        <Tech>{d.kind === 'api' ? 'GET api.heroku.com/apps/{app}/… from the controller' : 'parsed on the controller · values stay there'}</Tech>
      </div>
    </Section>
  );
}
