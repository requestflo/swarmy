import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { StatusWord } from '@/components/calm';

/** The calm right side of the Stream when no incident is open or chosen. */
export function NothingOpen(): React.JSX.Element {
  return (
    <section aria-label="Incidents" className="calm-card flex flex-col gap-2 px-6 py-8">
      <StatusWord tone="ok" word="Nothing open" />
      <h2 className="say text-[1.4rem]">No incident needs you.</h2>
      <p className="lede max-w-md text-[14px]">
        When an alert turns critical or a deploy fails its health check, swarmy opens an incident and it lands here, beside the stream,
        with every step on its timeline. Pick a past one from the stream to read its story.
      </p>
      <Link to="/activity" search={{ filter: 'incident' }} className="text-muted-foreground hover:text-foreground w-fit font-mono text-xs">
        Past incidents →
      </Link>
    </section>
  );
}
