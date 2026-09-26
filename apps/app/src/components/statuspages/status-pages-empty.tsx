import * as React from 'react';
import { Button } from '@swarmy/ui';
import { NextAction, Section } from '@/components/calm';
import { StatusPageInlineForm } from './status-page-inline-form';

/** No status page yet: sell it, then the create form in place. */
export function StatusPagesEmpty(): React.JSX.Element {
  const [creating, setCreating] = React.useState(false);
  if (creating) {
    return (
      <Section title="Create a status page">
        <StatusPageInlineForm onDone={() => setCreating(false)} onCancel={() => setCreating(false)} />
      </Section>
    );
  }
  return (
    <NextAction
      title="Give visitors a page they can check when something’s wrong."
      actions={<Button onClick={() => setCreating(true)} className="pointer-coarse:min-h-11">Create a status page</Button>}
    >
      It shows each part of your service with 90 days of uptime, and the updates you post during an incident. Its status comes from
      your apps’ health, never typed by hand, and it can live on your own address.
    </NextAction>
  );
}
