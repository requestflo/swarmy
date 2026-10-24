/**
 * View shapes for "Here's what we found" (board 24) — mirrors of
 * packages/app-config/src/scan/types.ts (Detection, BuildFacts) and
 * packages/trpc/src/services/git-scan.ts (AppScanView, DraftView). Kept local
 * so the app never imports server modules; tRPC's inferred types flow in.
 */
export type DetectionKind = 'web' | 'worker' | 'postgres' | 'cache' | 'queue' | 'bucket' | 'cron';

export interface Evidence {
  file: string;
  line: number;
  text: string;
}

export interface Detection {
  id: string;
  kind: DetectionKind;
  name: string;
  /** The swarmy.yaml key it maps to (`resources.db`). */
  maps: string;
  label: string;
  why: string;
  required?: boolean;
  evidence: Evidence[];
  port?: number;
  healthPath?: string;
  env?: string[];
  release?: string;
  command?: string;
  via?: 'script' | 'http' | 'clock' | 'in-process';
  schedule?: string;
  path?: string;
  host?: string;
}

export interface BuildFacts {
  dockerfile?: string;
  stages: string[];
  args: Array<{ name: string; default?: string }>;
}

/** `found` on a gitConnections.inspect({ scan: true }) result. */
export interface AppScan {
  dir: string;
  app: string;
  files: number;
  ms: number;
  detections: Detection[];
  build: BuildFacts;
}

/** The swarmy.yaml `build:` keys the advanced form edits. */
export interface BuildOptions {
  path?: string;
  dockerfile?: string;
  target?: string;
  args?: Record<string, string>;
  watch?: string[];
}

export interface AppGraph {
  stack: string;
  services: Array<{ name: string; meta: string; wires: string[] }>;
  data: Array<{ name: string; meta: string }>;
  jobs: Array<{ name: string; meta: string }>;
}

export interface Draft {
  yaml: string;
  valid: boolean;
  issues: Array<{ severity: 'error' | 'warning'; message: string; line?: number }>;
  notes: string[];
  graph: AppGraph | null;
}
