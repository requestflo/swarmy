import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { FilmIcon } from 'lucide-react';
import { timeAgo, type SignedInUser } from './rum-shared';

interface SignedInVisitorsProps {
  stack: string;
  users: SignedInUser[];
}

/** Identified mode: who was here, and a jump into their last replay. */
export function SignedInVisitors({ stack, users }: SignedInVisitorsProps): React.JSX.Element {
  return (
    <section className="calm-card shadow-none flex min-w-0 flex-col gap-1 p-5" aria-label="Signed-in visitors">
      <div className="flex items-baseline gap-2 pb-1">
        <h2 className="text-base font-bold">Signed-in visitors</h2>
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">{users.length} people</span>
      </div>
      {users.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">
          No one signed in yet. Visitors are identified once your app's login passes a user id to the recorder.
        </p>
      ) : (
        <ul className="divide-border flex flex-col divide-y">
          {users.slice(0, 10).map((u) => (
            <li key={u.userId} className="flex items-center gap-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{u.userId}</span>
                <span className="text-muted-foreground font-mono text-[11px]">
                  {[u.country || '—', `${u.pageviews} pages`, `${u.sessions} visits`, timeAgo(u.lastSeen)].join(' · ')}
                </span>
              </span>
              {u.lastSession ? (
                <Link
                  to="/stacks/$name/replays/$sessionId"
                  params={{ name: stack, sessionId: u.lastSession }}
                  className="text-primary inline-flex items-center gap-1 font-mono text-xs font-semibold"
                >
                  <FilmIcon className="size-3.5" /> watch replay
                </Link>
              ) : (
                <span className="text-muted-foreground font-mono text-xs">not recorded</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
