import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { BlueprintsPage } from '@/components/blueprints/blueprints-page';

export const Route = createFileRoute('/_authed/blueprints')({
  /** `?app=<template id>` opens that template's Configure panel (the Deploy hub links here). */
  validateSearch: (search: Record<string, unknown>): { app?: string } =>
    typeof search.app === 'string' && search.app ? { app: search.app } : {},
  component: BlueprintsRoute,
});

function BlueprintsRoute(): React.JSX.Element {
  const { app } = Route.useSearch();
  return <BlueprintsPage app={app} />;
}
