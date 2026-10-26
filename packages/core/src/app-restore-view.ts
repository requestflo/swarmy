/**
 * Whole-app restore, the shapes the dashboard reads: what the restore covers
 * (`backups.appRestoreScope`) and what each part did (`backups.restoreApp`).
 * The plan itself is `app-restore-plan.ts`.
 */
import type { AppRestorePart } from './app-restore-plan';

/** Why a volume or service is outside the stop-and-restore set. */
export type AppRestoreLeftOutWhy =
  /** A managed Postgres member or its data: restored as a database instead. */
  | 'database'
  /** A managed cache, search or vector store: swarmy leaves it running and untouched. */
  | 'managed'
  /** Runs on every server, so it can't be paused for the restore. */
  | 'global';

export interface AppRestoreScopeView {
  stack: string;
  /** Saved volumes put back as files. */
  volumes: string[];
  /** Saved volumes a whole-app restore leaves alone, and why. */
  leftOut: Array<{ volume: string; why: AppRestoreLeftOutWhy }>;
  /** Managed Postgres clusters put back as databases (each through its own restore path). */
  databases: string[];
  /** Services stopped once for the whole restore and started again at the end. */
  stops: Array<{ service: string; replicas: number }>;
  /** Services that keep running, and why. */
  keepsRunning: Array<{ service: string; why: AppRestoreLeftOutWhy }>;
}

/** One part after the run. */
export interface AppRestorePartOutcome extends AppRestorePart {
  /** The copy saved just before this part was written over (restore it to undo); null when none was taken. */
  safetySnapshotId: string | null;
  /** `skipped`: never reached, because an earlier part failed. */
  status: 'restored' | 'failed' | 'skipped';
  error?: string;
  /** After a failure: this part was put back from its safety copy, or putting it back failed. */
  undo?: 'done' | 'failed';
  undoError?: string;
}

export interface AppRestoreResultView {
  stack: string;
  /** The chosen moment, ISO. */
  at: string;
  skewMs: number;
  /** The services that were stopped and started again. */
  stopped: string[];
  parts: AppRestorePartOutcome[];
  /** Every part was restored, but some of the app did not start again. */
  startError?: string;
}
