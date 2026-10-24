/** Repo scan → what the app needs → a generated swarmy.yaml (see detect.ts, generate.ts). */
export * from './types';
export {
  SCAN_FILES,
  SCAN_PRESENCE_FILES,
  SOURCE_SCAN_PATTERN,
  SOURCE_SCAN_MAX_FILES,
  SOURCE_SCAN_MAX_HITS,
  SOURCE_SCAN_MAX_HITS_PER_FILE,
  isSourcePath,
  scanFile,
  scanHits,
} from './files';
export { detectAppNeeds, dockerfileFacts, type DetectOptions } from './detect';
export type { FrameworkHint } from './detect-process';
export { generateAppConfig, suggestAppName, type BuildOptions, type GenerateOptions, type GeneratedConfig } from './generate';
