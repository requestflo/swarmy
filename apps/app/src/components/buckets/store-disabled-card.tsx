import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArchiveIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

/**
 * Rendered when the replicated object store is off: buckets need Garage
 * running first. One clear CTA → the Backups page's replicated-store card.
 */
export function StoreDisabledCard(): React.JSX.Element {
  return (
    <div className="ink-block rounded-2xl p-8 sm:p-12">
      <ArchiveIcon className="size-8 opacity-80" aria-hidden />
      <h2 className="headline mt-4 text-3xl">
        Object storage is <em>off</em>.
      </h2>
      <p className="mt-3 max-w-xl text-sm opacity-80">
        Buckets run on swarmy&apos;s replicated object store (Garage) — an S3-compatible cluster on
        your own nodes. Turn it on once and every bucket, key and app attachment lives here.
      </p>
      <Button asChild className="mt-6">
        <Link to="/backups">Enable the replicated store</Link>
      </Button>
    </div>
  );
}
