import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { NextAction } from '@/components/calm';

/**
 * The honest next step after a conversion: the file goes into the repo by
 * your hand (swarmy has no way to write to git), then Connect a repo hands
 * the app to git. The page's one coral action.
 */
export function ConvertNext({ stack }: { stack: string }): React.JSX.Element {
  return (
    <NextAction
      tone="info"
      eyebrow="Next step"
      title="Put this file at the root of your repo and connect it: swarmy will manage the app from git."
      tech={`swarmy.yaml at the repo root · app: ${stack} · each push to the connected branch applies it`}
      actions={
        <Button asChild className="pointer-coarse:min-h-11">
          <Link to="/deploy" search={{ source: 'git' }}>
            Connect a repo
          </Link>
        </Button>
      }
      hint="swarmy can’t write to git, so nothing here commits or opens a pull request."
    >
      Copy or download it, commit it as swarmy.yaml, and connect that repo. From then on {stack} runs from the file. Look over what
      didn’t translate first.
    </NextAction>
  );
}
