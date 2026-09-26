import { createFileRoute, redirect } from '@tanstack/react-router';
import { BlueprintsPage } from '@/components/blueprints/blueprints-page';

export const Route = createFileRoute('/_authed/blueprints')({
  /** Old deep links (`?app=<template id>`) now open that template's Configure page. */
  validateSearch: (search: Record<string, unknown>): { app?: string } =>
    typeof search.app === 'string' && search.app ? { app: search.app } : {},
  beforeLoad: ({ search }) => {
    if (search.app) throw redirect({ to: '/deploy/$template', params: { template: search.app }, replace: true });
  },
  component: BlueprintsPage,
});
