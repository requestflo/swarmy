import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { IncidentDetailView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { Say, Section, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useStatusSnapshot } from '@/components/statuspages/use-status-snapshot';
import { PHASE_LABEL, hhmm, pageAddress, visitorPhrase } from '@/components/statuspages/status-copy';

/** What the public status page shows right now, and the way to tell visitors more. */
export function IncidentPublicCard({ incident }: { incident: IncidentDetailView }): React.JSX.Element {
  const { page, snapshot, isLoading } = useStatusSnapshot();
  const posted = snapshot?.incidents.find((i) => i.id === incident.id)?.publicUpdates?.[0];
  const open = incident.status === 'open';
  let body: React.ReactNode;
  if (isLoading) body = <CardSkeleton />;
  else if (!page) body = <p className="text-muted-foreground text-sm">You have no status page, so visitors can’t see this. One takes a minute to set up.</p>;
  else if (!snapshot) body = <p className="text-muted-foreground text-sm">{pageAddress(page)} is switched off, so visitors see nothing.</p>;
  else {
    const phrase = visitorPhrase(snapshot);
    body = (
      <>
        <p className="text-[14px] leading-snug">
          {pageAddress(page)} shows <Say tone={phrase.tone}><strong className="font-semibold">{phrase.text}</strong></Say>.{' '}
          {posted ? (
            <span className="text-muted-foreground">Last update {hhmm(posted.at)}: {PHASE_LABEL[posted.phase]} — {posted.message}</span>
          ) : open ? (
            <span className="text-muted-foreground">Tell visitors what’s going on?</span>
          ) : null}
        </p>
        {!page.showIncidents ? <p className="text-muted-foreground text-xs">This page hides incidents, so an update won’t show until you turn them on.</p> : null}
        <Tech>{`GET /status/${page.slug}.json · ${snapshot.incidents.length} incidents on the page`}</Tech>
      </>
    );
  }
  return (
    <Section
      title="Public status page"
      action={
        open || !page ? (
          <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
            {page ? (
              <Link to="/status-pages" search={{ incident: incident.id, ...(page ? { page: page.slug } : {}) }}>Post an update</Link>
            ) : (
              <Link to="/status-pages">Create one</Link>
            )}
          </Button>
        ) : undefined
      }
    >
      {body}
    </Section>
  );
}
