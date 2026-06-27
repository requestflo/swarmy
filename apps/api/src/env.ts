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
  /**
   * Where terminal session recordings (asciicast v2 `.cast` files) are written.
   * `recordingRef` rows store the relative path; the object-store epic can later
   * swap this sink for blob storage behind the same indirection. (epic #11)
   */
  TERM_RECORDING_DIR: process.env.SWARMY_TERM_RECORDING_DIR ?? '.swarmy/recordings',
  /**
   * node-onboarding P2: two-stage, checksum-pinned installer config.
   * `AGENT_VERSION` is the pinned path component; the binary base URL + per-platform
   * shas let the installer download + verify the native agent binary.
   */
  AGENT_VERSION: process.env.SWARMY_AGENT_VERSION ?? 'latest',
  AGENT_IMAGE: process.env.SWARMY_AGENT_IMAGE ?? 'ghcr.io/requestflo/swarmy-agent:latest',
  AGENT_BINARY_BASE_URL:
    process.env.SWARMY_AGENT_BINARY_BASE_URL ??
    `${process.env.CONTROLLER_PUBLIC_URL ?? 'http://localhost:3001'}/install/bin`,
  /** JSON map of `{ "linux-x64": "<sha256>", … }`; empty until release artifacts are published. */
  AGENT_BINARY_SHA256: process.env.SWARMY_AGENT_BINARY_SHA256 ?? '{}',
};
