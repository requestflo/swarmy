import type { Tone } from '@/components/calm';

/**
 * The Gitea / Forgejo card's pure bits: the scopes to grant (mirrors
 * GITEA_SCOPES in packages/trpc/src/services/git-providers/gitea.ts), what a
 * "Test connection" result says, and when the form can be sent.
 */
export type GiteaMode = 'token' | 'oauth';

export const GITEA_SCOPES: ReadonlyArray<{ scope: string; why: string }> = [
  { scope: 'write:repository', why: 'list repos and branches, add the webhook, post commit statuses' },
  { scope: 'write:issue', why: 'keep one preview comment on each pull request' },
  { scope: 'read:user', why: 'show which account the token belongs to' },
];

export const GITEA_CALLBACK_PATH = '/git/gitea/callback';

/** Mirror of `GiteaTestResult` (git-gitea.service.ts). */
export type GiteaTest =
  | {
      ok: true;
      flavor: 'gitea' | 'forgejo';
      version: string | null;
      account: string | null;
      canListRepos: boolean;
      missingScopes: string[];
    }
  | { ok: false; status: number | null; error: string };

const isUrl = (u: string): boolean => /^https?:\/\/[^/\s]+/.test(u.trim());

/** Can the form be sent? A server URL, plus a token or the OAuth app's id + secret. */
export function giteaReady(
  mode: GiteaMode,
  f: { baseUrl: string; token: string; clientId: string; clientSecret: string },
): boolean {
  if (!isUrl(f.baseUrl)) return false;
  return mode === 'token' ? f.token.trim().length >= 8 : Boolean(f.clientId.trim() && f.clientSecret);
}

/** "Test connection" in one plain sentence, with its tone. */
export function giteaTestLine(r: GiteaTest): { tone: Tone; text: string } {
  if (!r.ok) return { tone: 'bad', text: r.error };
  const server = `${r.flavor === 'forgejo' ? 'Forgejo' : 'Gitea'}${r.version ? ` ${r.version.split('+')[0]}` : ''}`;
  if (!r.account) return { tone: 'ok', text: `${server} answered. Sign in to finish.` };
  if (r.missingScopes.length)
    return { tone: 'warn', text: `Signed in as ${r.account}, but the token is missing ${r.missingScopes.join(', ')}.` };
  return { tone: 'ok', text: `${server} · signed in as ${r.account}. Your repos are readable.` };
}
