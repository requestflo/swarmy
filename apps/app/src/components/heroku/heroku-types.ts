import type { HerokuImportPlan, HerokuMigration } from '@swarmy/app-config';
import type { HerokuImportSource } from '@swarmy/core';

/**
 * The `herokuImport.*` results, as the dashboard reads them (mirrors
 * packages/trpc/src/services/heroku-import/*; the mutations' inferred types
 * are checked against these where they're passed on).
 */
export interface HerokuImportView {
  source: 'api' | 'paste';
  herokuApp: string;
  app: string;
  plan: HerokuImportPlan;
  yaml: string;
  valid: boolean;
  issues: Array<{ severity: 'error' | 'warning'; message: string; line?: number }>;
  changes: string[];
  steps: HerokuMigration;
  sealable: string[];
  copyable: string[];
}

export interface HerokuDeployStep {
  key: string;
  say: string;
  status: 'created' | 'already' | 'skipped' | 'failed';
}

export interface HerokuDeployResult {
  stack: string;
  steps: HerokuDeployStep[];
  yaml: string;
}

export interface HerokuCopyResult {
  stack: string;
  cluster: string;
  status: 'copied' | 'copied-with-errors' | 'not-empty' | 'failed';
  tables: number | null;
  say: string;
}

export type { HerokuImportSource };

/** Which way in the form is on. */
export type HerokuSourceKind = HerokuImportSource['kind'];

export interface HerokuSourceDraft {
  kind: HerokuSourceKind;
  token: string;
  app: string;
  appJson: string;
  procfile: string;
  config: string;
  domains: string;
}

export const EMPTY_DRAFT: HerokuSourceDraft = { kind: 'api', token: '', app: '', appJson: '', procfile: '', config: '', domains: '' };
