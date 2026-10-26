import * as React from 'react';
import { Button, Input, Label } from '@swarmy/ui';
import { CodeView, NextAction, Tech } from '@/components/calm';
import { deploySentence } from './heroku-import-model';
import type { HerokuImport } from './use-heroku-import';

/** The swarmy.yaml at Code depth, then the one coral step: Deploy (with the app's swarmy name). */
export function HerokuDeployAside({ h }: { h: HerokuImport }): React.JSX.Element | null {
  const v = h.view;
  const [name, setName] = React.useState(v?.app ?? '');
  React.useEffect(() => setName(v?.app ?? ''), [v?.app]);
  if (!v) return null;
  const done = Boolean(h.deployed);
  return (
    <>
      <CodeView
        title="The imported swarmy.yaml"
        tabs={[{ label: 'swarmy.yaml', code: v.yaml }]}
        note="Commit it at the root of the app’s repo: the push that carries it builds and deploys the services."
      />
      {done ? (
        <section aria-label="Where it stands" className="calm-card flex flex-col gap-1.5 px-5 py-4 text-[13px]">
          <span className="calm-eyebrow">Set up on swarmy</span>
          <span>
            <b className="font-semibold">{v.app}</b> has its data stores and secrets. The services come with the first push of swarmy.yaml.
          </span>
          <Tech>{`from ${v.source === 'api' ? 'the Heroku API' : 'pasted files'} · heroku app ${v.herokuApp}`}</Tech>
        </section>
      ) : (
        <NextAction
          eyebrow="Nothing has run yet"
          title={`Deploy ${v.app}`}
          tone={v.valid ? 'info' : 'bad'}
          tech={`from ${v.source === 'api' ? 'the Heroku API' : 'pasted files'} · heroku app ${v.herokuApp}`}
          actions={
            <Button size="lg" onClick={h.deploy} disabled={!v.valid || h.deploying || h.reviewing} className="pointer-coarse:min-h-11">
              {h.deploying ? 'Deploying…' : 'Deploy'}
            </Button>
          }
        >
          {v.valid ? deploySentence(v) : 'The swarmy.yaml has errors, so Deploy waits: they’re listed under Needs a fix.'}
        </NextAction>
      )}
      {done ? null : (
        <form
          className="calm-card flex flex-col gap-2 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            h.rename(name.trim());
          }}
        >
          <Label htmlFor="heroku-name" className="text-[13px] font-semibold">
            Name on swarmy
          </Label>
          <div className="flex gap-2">
            <Input id="heroku-name" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} className="font-mono" />
            <Button type="submit" variant="outline" disabled={!name.trim() || name.trim() === v.app || h.reviewing} className="pointer-coarse:min-h-11">
              Rename
            </Button>
          </div>
          <span className="text-muted-foreground text-[12px]">The app, its addresses and its data are named after it.</span>
        </form>
      )}
    </>
  );
}
