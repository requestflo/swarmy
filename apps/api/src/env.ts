function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v == null) throw new Error(`missing env ${name}`);
  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT ?? 3001),
  DATABASE_URL: required('DATABASE_URL', 'postgresql://swarmy:swarmy@localhost:5678/swarmy'),
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
  CONTROLLER_PUBLIC_URL: process.env.CONTROLLER_PUBLIC_URL ?? 'http://localhost:3001',
  /** Metrics rollup flush + retention. */
  METRICS_SAMPLE_INTERVAL_MS: Number(process.env.METRICS_SAMPLE_INTERVAL_MS ?? 60_000),
  METRICS_RETENTION_DAYS: Number(process.env.METRICS_RETENTION_DAYS ?? 14),
};
