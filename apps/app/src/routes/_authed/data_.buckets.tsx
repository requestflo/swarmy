import { createFileRoute } from '@tanstack/react-router';
import { BucketsPage } from '@/components/buckets/buckets-page';

export const Route = createFileRoute('/_authed/data_/buckets')({
  component: BucketsPage,
});
