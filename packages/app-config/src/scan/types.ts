/**
 * What a repo scan found that an app needs — the shared shape the controller
 * (git.inspect → the New app wizard), the CLI (`swarmy check`) and MCP
 * `check_repo` all report. Each detection carries its evidence (file + line)
 * and the swarmy.yaml key it maps to, so "why do you think I need Redis?" is
 * always answerable.
 *
 * The Zod schema exists because the dashboard echoes ticked detections back
 * to `gitConnections.draftConfig`; the generated text is then re-parsed with
 * `parseAppConfig`, so a tampered detection can only produce an invalid file.
 */
import { z } from 'zod';
import { UNIT_NAME_RE } from '../schema';

export const DETECTION_KINDS = ['web', 'worker', 'postgres', 'cache', 'queue', 'bucket', 'cron'] as const;
export type DetectionKind = (typeof DETECTION_KINDS)[number];

/** How a scheduled task runs: a script on a cadence, a Vercel-style HTTP cron, a clock process, or in-process. */
export const CRON_VIA = ['script', 'http', 'clock', 'in-process'] as const;
export type CronVia = (typeof CRON_VIA)[number];

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const EvidenceSchema = z.object({
  /** Repo-relative path. */
  file: z.string().min(1).max(300),
  /** 1-based line. */
  line: z.number().int().min(1),
  /** The line itself, trimmed (≤ 160 chars). */
  text: z.string().max(200),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const DetectionSchema = z.object({
  /** Stable id within one scan (`postgres`, `worker:jobs`, `cron:cleanup`). */
  id: z.string().regex(/^[a-z][a-z0-9:-]{0,70}$/),
  kind: z.enum(DETECTION_KINDS),
  /** The unit it writes: a service, resource or job name. */
  name: z.string().regex(UNIT_NAME_RE),
  /** The swarmy.yaml key it maps to (`resources.db`, `services.worker`, `jobs.cleanup`). */
  maps: z.string().max(120),
  /** Plain words: what was found ("Postgres", "Background worker"). */
  label: z.string().max(80),
  /** Plain words: why, and what swarmy does with it. */
  why: z.string().max(240),
  /** Plain words: what in the repo says so ("uses Prisma with PostgreSQL in prisma/schema.prisma"). */
  reason: z.string().max(200).optional(),
  /** The app can't do without it (the web service). */
  required: z.boolean().optional(),
  evidence: z.array(EvidenceSchema).min(1).max(6),
  /** web: the port it listens on. */
  port: z.number().int().min(1).max(65535).optional(),
  /** web: the HTTP health path its framework answers. */
  healthPath: z.string().startsWith('/').max(200).optional(),
  /** Env vars the app reads for this thing (bound to `${{ <name>.<field> }}`). */
  env: z.array(envName).max(8).optional(),
  /** postgres: the migration command to run before each release. */
  release: z.string().min(1).max(200).optional(),
  /** worker / cron: the command it runs. */
  command: z.string().min(1).max(300).optional(),
  /** cron: how it runs. */
  via: z.enum(CRON_VIA).optional(),
  /** cron: a five-field schedule, when the repo says one. */
  schedule: z.string().max(60).optional(),
  /** cron via http: the path to call. */
  path: z.string().startsWith('/').max(200).optional(),
  /** cron in-process: the service it runs inside. */
  host: z.string().regex(UNIT_NAME_RE).optional(),
  /** cron via script: the image it runs in, when not the app's own build (a compose service's `image:`). */
  image: z.string().min(1).max(200).optional(),
});
export type Detection = z.infer<typeof DetectionSchema>;

/** A file the scan read: every line (local disk, probes) or only the lines a grep matched (git.inspect). */
export interface ScanLine {
  no: number;
  text: string;
}
export interface ScanFile {
  path: string;
  lines: ScanLine[];
}

/** Build facts the "Build · advanced" form offers (from the Dockerfile). */
export interface BuildFacts {
  /** Repo-relative Dockerfile path, when there is one. */
  dockerfile?: string;
  /** `FROM … AS <stage>` names, in order. */
  stages: string[];
  /** `ARG NAME[=default]` lines. */
  args: Array<{ name: string; default?: string }>;
}

/** A whole scan: what was found, how many files were read, and the build facts. */
export interface ScanResult {
  detections: Detection[];
  /** Distinct files the detectors read. */
  files: number;
  build: BuildFacts;
}
