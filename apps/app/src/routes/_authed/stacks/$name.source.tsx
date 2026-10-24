import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SourceTab } from '@/components/stacks/source/source-tab';

interface SourceSearch {
  /** Show a compose app's spec converted to swarmy.yaml. */
  convert?: true;
}

/** Source: the spec this app runs from, read-only. Edit it in git. */
export const Route = createFileRoute('/_authed/stacks/$name/source')({
  validateSearch: (search: Record<string, unknown>): SourceSearch =>
    search.convert === true || search.convert === 1 || search.convert === '1' || search.convert === 'true' ? { convert: true } : {},
  component: Page,
});

function Page(): React.JSX.Element {
  const { name } = Route.useParams();
  const { convert } = Route.useSearch();
  return <SourceTab stack={name} convert={Boolean(convert)} />;
}
