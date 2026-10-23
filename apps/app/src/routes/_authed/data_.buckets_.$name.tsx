import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { BucketPage } from '@/components/buckets/bucket-page';

/** One bucket (board 42): who can reach it, its size and copies, who uses it, its keys. */
export const Route = createFileRoute('/_authed/data_/buckets_/$name')({
  component: BucketRoute,
});

function BucketRoute(): React.JSX.Element {
  const { name } = Route.useParams();
  return <BucketPage name={name} />;
}
