import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

export interface LinkedApp {
  /** owner/name (from the binding, else parsed from its URL). */
  fullName: string;
  url: string;
  branch: string;
  configPath: string;
  name: string;
  /** The production stack, for "Open <app>". */
  stack: string | null;
}

const nameOf = (url: string): string => url.replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/');
/** Clone URLs compare without `.git`, a trailing slash or case. */
const norm = (url: string): string => url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');

/** The git apps this org already has (`apps.list`), so the wizard can say "already an app" instead of linking twice. */
export function useLinkedApps() {
  const trpc = useTRPC();
  const apps = useQuery(trpc.apps.list.queryOptions());
  return React.useMemo(() => {
    const rows: LinkedApp[] = (apps.data ?? []).map((a) => {
      const prod = a.environments.find((e) => e.environment === 'production') ?? a.environments[0];
      return {
        fullName: a.fullName ?? nameOf(a.url),
        url: a.url,
        branch: a.branch,
        configPath: a.configPath,
        name: a.appName ?? prod?.stack ?? nameOf(a.url),
        stack: prod?.stack ?? null,
      };
    });
    /** Names of the apps deployed from this repo. */
    const namesFor = (cloneUrl: string): string[] => rows.filter((r) => norm(r.url) === norm(cloneUrl)).map((r) => r.name);
    /** The app at this repo + swarmy.yaml (any branch). */
    const at = (cloneUrl: string, configPath: string): LinkedApp | undefined =>
      rows.find((r) => norm(r.url) === norm(cloneUrl) && r.configPath === configPath);
    return { rows, namesFor, at };
  }, [apps.data]);
}

export type LinkedApps = ReturnType<typeof useLinkedApps>;
