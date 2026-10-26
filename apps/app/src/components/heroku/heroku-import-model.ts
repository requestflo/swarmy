import { HerokuImportSource } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { HerokuDeployStep, HerokuImportView, HerokuSourceDraft } from './heroku-types';

/** The form → what the controller reads, or the first thing to fix (in the field's words). */
export function toSource(d: HerokuSourceDraft): { source: HerokuImportSource } | { error: string } {
  const raw = d.kind === 'api' ? { kind: 'api', token: d.token, app: d.app } : { kind: 'paste', appJson: d.appJson, procfile: d.procfile, config: d.config, domains: d.domains };
  if (d.kind === 'paste' && !d.appJson.trim() && !d.procfile.trim()) return { error: 'Paste the Procfile, app.json or both.' };
  const r = HerokuImportSource.safeParse(raw);
  return r.success ? { source: r.data } : { error: r.error.issues[0]?.message ?? 'Check the form.' };
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const and = (xs: string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''));

/** What pressing Deploy does, in one sentence. */
export function deploySentence(v: HerokuImportView): string {
  const stores = v.plan.data.map((d) => d.name);
  const parts = [
    ...(stores.length ? [`starts ${and(stores)}`] : []),
    ...(v.sealable.length ? [`seals ${count(v.sealable.length, 'secret')} with Heroku’s values`] : []),
  ];
  const head = parts.length ? `Deploy ${and(parts)}.` : 'Deploy has nothing to start yet: this app has no data stores or secrets.';
  return `${head} Your ${count(v.plan.services.length, 'service')} deploy${v.plan.services.length === 1 ? 's' : ''} when swarmy.yaml lands in your repo.`;
}

export const STEP_TONE: Record<HerokuDeployStep['status'], Tone> = { created: 'ok', already: 'idle', skipped: 'warn', failed: 'bad' };
export const STEP_WORD: Record<HerokuDeployStep['status'], string> = { created: 'Done', already: 'Kept', skipped: 'Needs you', failed: 'Failed' };

/** A Rails app, so the paste way can be tried without a Heroku account. Placeholders only. */
export const HEROKU_SAMPLE: Pick<HerokuSourceDraft, 'appJson' | 'procfile' | 'config' | 'domains'> = {
  appJson: JSON.stringify(
    {
      name: 'shop-classic',
      formation: { web: { quantity: 2, size: 'standard-2x' }, worker: { quantity: 1, size: 'standard-1x' } },
      addons: ['heroku-postgresql:standard-0', 'heroku-redis:mini', 'scheduler:standard'],
      buildpacks: [{ url: 'heroku/ruby' }, { url: 'heroku/nodejs' }],
    },
    null,
    2,
  ),
  procfile: 'web: bundle exec puma -C config/puma.rb\nworker: bundle exec sidekiq\nrelease: bundle exec rails db:migrate\n',
  config: [
    "DATABASE_URL='postgres://user:password@ec2-0-0-0-0.compute-1.amazonaws.com:5432/dbname'",
    "REDIS_URL='redis://:password@ec2-0-0-0-0.compute-1.amazonaws.com:6379'",
    "SECRET_KEY_BASE='replace-me-0123456789abcdef0123456789abcdef'",
    "RAILS_ENV='production'",
    "RAILS_SERVE_STATIC_FILES='enabled'",
  ].join('\n'),
  domains: 'shop.example.com',
};
