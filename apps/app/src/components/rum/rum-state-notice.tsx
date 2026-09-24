import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ActivityIcon, CloudOffIcon, HardDriveIcon, PowerIcon, SearchXIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';

export type RumNoticeKind =
  | 'analytics-disabled'
  | 'replay-disabled'
  | 'unreachable'
  | 'no-store'
  | 'not-found'
  | 'off';

interface RumStateNoticeProps {
  stack: string;
  kind: RumNoticeKind;
}

const linkCls = 'text-primary font-semibold';

/**
 * Every state that isn't data, said in plain words with the one thing to turn
 * on: analytics and the replay index live in the observability store, replay
 * recordings live in object storage.
 */
export function RumStateNotice({ stack, kind }: RumStateNoticeProps): React.JSX.Element {
  const toObs = (
    <Link to="/stacks/$name/observability" params={{ name: stack }} className={linkCls}>
      Turn on observability →
    </Link>
  );
  const toSettings = (
    <Link to="/stacks/$name/rum-settings" params={{ name: stack }} className={linkCls}>
      Open replay & analytics settings →
    </Link>
  );
  switch (kind) {
    case 'analytics-disabled':
      return (
        <EmptyState
          icon={<ActivityIcon />}
          title="Web analytics needs observability turned on."
          description="Visits are counted at the edge and stored in the observability store (ClickHouse). Turn observability on and counting starts on the next page view — no script to add."
          action={toObs}
        />
      );
    case 'replay-disabled':
      return (
        <EmptyState
          icon={<ActivityIcon />}
          title="Session replay needs observability and object storage."
          description="The replay index lives in the observability store, the recordings in object storage. Turn observability on first."
          action={toObs}
        />
      );
    case 'no-store':
      return (
        <EmptyState
          icon={<HardDriveIcon />}
          title="Replays need object storage."
          description="Recordings are kept as chunks in swarmy's object storage (Garage). Set up object storage and new sessions are recorded straight away."
          action={
            <Link to="/data/buckets" className={linkCls}>
              Set up object storage →
            </Link>
          }
        />
      );
    case 'unreachable':
      return (
        <EmptyState
          icon={<CloudOffIcon />}
          title="The observability store isn't answering."
          description="It may be restarting or out of disk. Nothing is lost at the edge — this page retries on its own."
          action={toObs}
        />
      );
    case 'not-found':
      return (
        <EmptyState
          icon={<SearchXIcon />}
          title="That session isn't here any more."
          description="It aged out of retention or was deleted. Pick another session from the list."
        />
      );
    case 'off':
      return (
        <EmptyState
          icon={<PowerIcon />}
          title="Analytics and replay are off for this app."
          description="Turn them on in settings. The edge adds the tag to your pages — your app is never modified or redeployed."
          action={toSettings}
        />
      );
  }
}
