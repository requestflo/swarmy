import type { InvService } from '@swarmy/core';

/**
 * A plain description of what a part of an app does, guessed from its name and
 * image ("What visitors see", "Keeps your data"). Summary depth shows this
 * instead of an image reference; the image lives on the Controls line.
 */
const RULES: [RegExp, string][] = [
  [/postgres|mysql|mariadb|mongo|cockroach|timescale/, 'Keeps your data'],
  [/redis|valkey|memcache|keydb|dragonfly/, 'Makes pages quicker'],
  [/nats|rabbit|kafka|queue|bullmq/, 'Passes messages between parts'],
  [/worker|job|cron|sidekiq|celery/, 'Does work in the background'],
  [/checkout|payment|stripe|billing/, 'Takes payments'],
  [/meili|typesense|elastic|opensearch|search/, 'Finds things fast'],
  [/qdrant|weaviate|milvus|vector/, 'Remembers meaning for AI search'],
  [/minio|garage|s3|media|upload|storage/, 'Stores files'],
  [/grafana|prometheus|loki|otel|clickhouse|collector/, 'Watches how things run'],
  [/caddy|nginx|traefik|haproxy|ingress|edge|cdn|proxy/, 'Brings visitors in'],
  [/cloudflared|tunnel/, 'Connects out to the internet'],
  [/api|backend|server|graphql/, 'Answers the site’s requests'],
  [/web|site|frontend|next|nuxt|ui|app|shop|store|ghost|wordpress/, 'What visitors see'],
  [/n8n|automation|workflow/, 'Runs your automations'],
];

export function serviceRole(s: Pick<InvService, 'name' | 'image' | 'labels'>): string {
  const hay = `${s.name} ${s.image}`.toLowerCase();
  if (s.labels['swarmy.db.cluster']) return 'Keeps your data';
  for (const [re, say] of RULES) if (re.test(hay)) return say;
  return 'Part of this app';
}
