import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { NextAction } from '@/components/calm';

/**
 * Rendered when the replicated object store is off: buckets need it running
 * first. One clear action → the Backups page's store card.
 */
export function StoreDisabledCard(): React.JSX.Element {
  return (
    <NextAction
      title="Turn on file storage to create buckets"
      tech="garage · the replicated object store, one member per server"
      actions={
        <Button asChild>
          <Link to="/backups">Turn on file storage</Link>
        </Button>
      }
    >
      It runs on your own servers and keeps each file on several of them. Turn it on once; every bucket, key and app
      attachment lives there.
    </NextAction>
  );
}
