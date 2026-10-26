import * as React from 'react';
import { CodeView } from '@/components/calm';

const CLI = [
  '# the token, for "With a Heroku token"',
  'heroku auth:token',
  '',
  '# or the files, for "Paste the files" (from the app’s repo)',
  'cat Procfile app.json',
  'heroku config -s --app <app>',
  'heroku domains --app <app>',
].join('\n');

const READS: Array<[string, string]> = [
  ['Processes', 'web gets the address; workers and clocks run beside it; release runs before each deploy.'],
  ['Dynos', 'how many and how big become copies and CPU + memory limits.'],
  ['Add-ons', 'Postgres and Redis become databases swarmy runs and backs up. Others are listed with what to do.'],
  ['Config vars', 'settings go into swarmy.yaml; anything that looks secret is sealed instead.'],
  ['Domains', 'move to web once their DNS points at your servers.'],
];

/** Before the plan: what the import reads, what it never does, and the commands that give it the files. */
export function HerokuImportAside(): React.JSX.Element {
  return (
    <>
      <CodeView title="Where the inputs come from" tabs={[{ label: 'heroku CLI', code: CLI }]} source="readonly" note="Real Heroku CLI commands: run them where you’re signed in to Heroku." />
      <section aria-label="What the import reads" className="calm-card flex flex-col gap-3 px-5 py-4">
        <h2 className="font-display text-[16.5px] font-bold tracking-[-0.01em]">What it reads</h2>
        <dl className="flex flex-col gap-2 text-[13px] leading-snug">
          {READS.map(([k, v]) => (
            <div key={k}>
              <dt className="font-semibold">{k}</dt>
              <dd className="text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground border-t pt-3 text-[12.5px] leading-relaxed">
          It never changes the Heroku app. The token stays in this page while you work, is used only to read, and is never stored.
        </p>
      </section>
    </>
  );
}
