import * as React from 'react';

/** A row sentence built from short phrases joined by " · "; a phrase never breaks inside itself. */
export function SayParts({ parts }: { parts: Array<string | false | null | undefined> }): React.JSX.Element {
  const shown = parts.filter((p): p is string => Boolean(p));
  return (
    <>
      {shown.map((p, i) => (
        <React.Fragment key={p}>
          {i > 0 ? ' · ' : null}
          <span className="whitespace-nowrap">{p}</span>
        </React.Fragment>
      ))}
    </>
  );
}
