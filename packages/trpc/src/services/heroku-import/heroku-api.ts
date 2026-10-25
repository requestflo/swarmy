/**
 * Reading a Heroku app through the Platform API (https://api.heroku.com),
 * from the controller only. The token rides the Authorization header of
 * these GETs and nothing else: it is never stored, logged, audited or put in
 * an error message. Every read is a GET; swarmy never changes the Heroku app.
 */
import { TRPCError } from '@trpc/server';
import type { HerokuApiSnapshot } from '@swarmy/app-config';

export const HEROKU_API = 'https://api.heroku.com';
const TIMEOUT_MS = 15_000;

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export class HerokuApiError extends TRPCError {
  constructor(status: number, path: string) {
    const what =
      status === 401
        ? 'Heroku didn’t accept that token. Run `heroku auth:token` and paste it again.'
        : status === 403
          ? 'That token can’t read this app. Use a token from an account with access to it.'
          : status === 404
            ? 'Heroku has no app by that name for this token.'
            : status === 429
              ? 'Heroku is rate-limiting this token. Try again in a minute.'
              : `Heroku answered ${status} for ${path}.`;
    super({ code: status === 401 || status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'BAD_GATEWAY', message: what });
  }
}

export function herokuClient(token: string, fetchImpl: Fetch = fetch as unknown as Fetch) {
  const headers = { Accept: 'application/vnd.heroku+json; version=3', Authorization: `Bearer ${token}` };
  return async function get<T>(path: string, extra: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${HEROKU_API}${path}`, { headers: { ...headers, ...extra }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Couldn’t reach api.heroku.com from the controller.' });
    }
    if (!res.ok) throw new HerokuApiError(res.status, path.replace(/\/apps\/[^/]+/, '/apps/{app}'));
    return (await res.json()) as T;
  };
}

type Get = ReturnType<typeof herokuClient>;
interface Release { current?: boolean; slug?: { id?: string } | null }

/** The current release's slug `process_types` (the whole Procfile), or null for a slug-less release. */
async function processTypes(get: Get, app: string): Promise<Record<string, string> | null> {
  const releases = await get<Release[]>(`/apps/${app}/releases`, { Range: 'version ..; order=desc, max=20' });
  const slug = (releases.find((r) => r.current) ?? releases[0])?.slug?.id;
  if (!slug) return null;
  const s = await get<{ process_types?: Record<string, string> | null }>(`/apps/${app}/slugs/${encodeURIComponent(slug)}`);
  return s.process_types ?? null;
}

/** Everything the importer reads about one app, in parallel. */
export async function readHerokuApp(token: string, appName: string, fetchImpl?: Fetch): Promise<HerokuApiSnapshot> {
  const get = herokuClient(token, fetchImpl);
  const app = encodeURIComponent(appName);
  const info = await get<HerokuApiSnapshot['app']>(`/apps/${app}`);
  const [formation, procs, addons, buildpacks, configVars, domains] = await Promise.all([
    get<HerokuApiSnapshot['formation']>(`/apps/${app}/formation`),
    processTypes(get, app),
    get<HerokuApiSnapshot['addons']>(`/apps/${app}/addons`),
    get<HerokuApiSnapshot['buildpacks']>(`/apps/${app}/buildpack-installations`),
    get<HerokuApiSnapshot['configVars']>(`/apps/${app}/config-vars`),
    get<HerokuApiSnapshot['domains']>(`/apps/${app}/domains`),
  ]);
  return { app: { name: info.name, stack: info.stack ?? null }, formation, processTypes: procs, addons, buildpacks, configVars, domains };
}

/** Only the config vars (the data copy needs DATABASE_URL, nothing else). */
export async function readHerokuConfigVars(token: string, appName: string, fetchImpl?: Fetch): Promise<Record<string, string>> {
  const vars = await herokuClient(token, fetchImpl)<Record<string, string | null>>(`/apps/${encodeURIComponent(appName)}/config-vars`);
  return Object.fromEntries(Object.entries(vars).flatMap(([k, v]) => (v === null ? [] : [[k, v]])));
}
