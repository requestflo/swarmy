import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button, toast } from '@swarmy/ui';
import { CalmRow, NextAction, RowList, Section } from '@/components/calm';
import { download } from '@/components/studio/studio-export';
import { STEP_TONE, STEP_WORD } from './heroku-import-model';
import type { HerokuDeployResult } from './heroku-types';

/**
 * Step 3, done: what Deploy set up (each store and secret, said plainly),
 * then the one thing left — bring the code. swarmy builds from git, so the
 * swarmy.yaml goes into the app's repo and that push deploys the services.
 */
export function HerokuDeployResultView({ result }: { result: HerokuDeployResult }): React.JSX.Element {
  const copy = (): void => {
    void navigator.clipboard.writeText(result.yaml).then(
      () => toast.success('Copied — commit it as swarmy.yaml.'),
      () => toast.error('Couldn’t reach the clipboard — use Download instead.'),
    );
  };
  return (
    <>
      <Section title="What Deploy did" count={result.steps.length} flush={result.steps.length > 0}>
        {result.steps.length ? (
          <RowList>
            {result.steps.map((s) => (
              <CalmRow key={s.key} tone={STEP_TONE[s.status]} name={s.key.split('.').pop()} sub={s.key} say={s.say} word={STEP_WORD[s.status]} />
            ))}
          </RowList>
        ) : (
          <p className="text-muted-foreground text-[13.5px]">This app has no data stores or secrets to set up.</p>
        )}
      </Section>
      <NextAction
        eyebrow="Next"
        tone="info"
        title="Bring the code: commit swarmy.yaml and connect the repo."
        tech={`swarmy.yaml at the repo root · the push builds with Railpack and deploys ${result.stack}`}
        actions={
          <>
            <Button asChild size="lg" className="pointer-coarse:min-h-11">
              <Link to="/deploy" search={{ source: 'git' }}>
                Connect a repo
              </Link>
            </Button>
            <Button variant="outline" onClick={copy} className="pointer-coarse:min-h-11">
              Copy swarmy.yaml
            </Button>
            <Button variant="ghost" onClick={() => download('swarmy.yaml', result.yaml, 'application/yaml')} className="pointer-coarse:min-h-11">
              Download
            </Button>
          </>
        }
      >
        The first push builds the app on your servers and starts its services against the data set up here. It asks you to confirm
        swarmy taking over {result.stack}’s data stores, since they were started before the file existed.
      </NextAction>
    </>
  );
}
