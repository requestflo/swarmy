import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ServiceOverlay } from '@/components/services/service-overlay';
import { AppOverviewTab } from '@/components/stacks/workspace/app-overview-tab';

interface StackOverviewSearch {
  /** Selected part: its bottom sheet shows on the canvas. */
  part?: string;
  /** Open service overlay — in the URL so it deep-links and Back closes it. */
  service?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The app's Overview tab: how it is built (the live canvas), facts and the next thing worth doing. */
export const Route = createFileRoute('/_authed/stacks/$name/')({
  validateSearch: (search: Record<string, unknown>): StackOverviewSearch => {
    const out: StackOverviewSearch = {};
    const part = str(search.part);
    const service = str(search.service);
    if (part) out.part = part;
    if (service) out.service = service;
    return out;
  },
  component: StackOverviewTab,
});

function StackOverviewTab(): React.JSX.Element {
  const { name } = Route.useParams();
  const { part, service } = Route.useSearch();
  const navigate = Route.useNavigate();
  const originRef = React.useRef<{ x: number; y: number } | null>(null);

  return (
    <>
      <AppOverviewTab
        stack={name}
        part={part}
        onSelect={(id) => void navigate({ search: id ? { part: id } : {}, replace: true, resetScroll: false })}
        onOpen={(id, origin) => {
          originRef.current = origin;
          void navigate({ search: { part, service: id }, resetScroll: false });
        }}
      />
      {service ? (
        <ServiceOverlay
          serviceId={service}
          origin={originRef.current}
          onClose={() => void navigate({ search: part ? { part } : {}, resetScroll: false })}
          onSwitch={(id) => {
            originRef.current = null;
            void navigate({ search: { part, service: id }, replace: true, resetScroll: false });
          }}
        />
      ) : null}
    </>
  );
}
