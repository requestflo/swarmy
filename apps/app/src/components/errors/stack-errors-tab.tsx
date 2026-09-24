import * as React from 'react';
import { ErrorsSetupCard } from './errors-setup-card';
import { IssuesList } from './issues-list';

/** The stack workspace Errors tab: the DSN + opt-in up top, then the grouped issues. */
export function StackErrorsTab({ stack }: { stack: string }): React.JSX.Element {
  return (
    <div className="pb-8">
      <ErrorsSetupCard stack={stack} />
      <IssuesList stack={stack} />
    </div>
  );
}
