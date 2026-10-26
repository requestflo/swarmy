import { declaredEnvByService, parseAppConfig } from '@swarmy/app-config';
import type { DomainResolvers } from '../types';
import { appClone } from './app-clone';
import { STOREFRONT_YAML } from './apps-config-file';

/**
 * `apps.declaredEnv` in demo mode (board 58, Paste .env): what storefront's
 * swarmy.yaml declares per environment and service, from the real parser and
 * `declaredEnvByService` — production, staging, and any clone made in the
 * demo (as the environment it came from). payments' file doesn't parse, so
 * nothing of it is locked.
 */
interface ListedApp {
  appName: string;
  configPath: string;
  environments: Array<{ environment: string; stack: string; latest: { sha: string } | null; dashboard?: { from: string } }>;
  previews: Array<{ stack: string }>;
}

export const appsDeclaredEnv: DomainResolvers = {
  handlers: {
    'apps.declaredEnv': (i, s) => {
      const { stack } = i as { stack: string };
      const list = appClone.handlers!['apps.list']!(undefined, s) as ListedApp[];
      const app = list.find((a) => a.environments.some((e) => e.stack === stack) || a.previews.some((p) => p.stack === stack));
      if (!app) return null;
      const sha = app.environments[0]?.latest?.sha ?? '0'.repeat(40);
      const cfg = app.appName === 'storefront' ? parseAppConfig(STOREFRONT_YAML).config : null;
      if (!cfg) {
        return { path: app.configPath, sha, reason: `${app.configPath} doesn't parse: replicas must be a whole number, got “two”.`, environments: [] };
      }
      return {
        path: app.configPath,
        sha,
        reason: null,
        environments: app.environments.map((e) => ({
          environment: e.environment,
          stack: e.stack,
          services: declaredEnvByService(cfg, e.environment, e.dashboard?.from),
        })),
      };
    },
  },
};
