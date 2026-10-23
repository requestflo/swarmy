import * as React from 'react';
import { Button } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import type { useFrontDoor } from './use-front-door';

/** The Front door's next action: the edge isn't serving (and how to turn it on), or the dashboard address is dark. */
export function FrontDoorNext({ f }: { f: ReturnType<typeof useFrontDoor> }): React.JSX.Element | null {
  const c = f.config.data;
  if (!c) return null;
  const problem = !c.runtime.serving && f.driver !== 'none';
  return (
    <>
      {problem ? (
        <NextAction
          title={c.runtime.state === 'paused' ? 'The front door is paused' : 'The front door is not up yet'}
          tech={`runtime: ${c.runtime.state} · ${c.runtime.runningTasks}/${c.runtime.desiredTasks ?? '–'} tasks`}
          actions={
            c.runtime.state === 'paused' ? (
              <Button onClick={() => f.setEnabled.mutate({ enabled: true })} disabled={f.setEnabled.isPending}>
                Turn it on
              </Button>
            ) : undefined
          }
        >
          {c.runtime.message}
        </NextAction>
      ) : null}
      {c.dashboardWarning ? (
        <NextAction tone="bad" title="The dashboard's https address isn't served">
          {c.dashboardWarning}
        </NextAction>
      ) : null}
    </>
  );
}
