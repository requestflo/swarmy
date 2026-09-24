/**
 * Error tracking's public surface for apps/api (which can only import the
 * @swarmy/trpc root): the ingest pipeline, artifact upload, the spike sweep,
 * and the pure helpers the controller shell needs.
 */
export { ingest, storeEvents, type IngestDeps, type IngestRequest, type IngestResponse } from './ingest';
export { uploadArtifacts, recordDeployRelease, stackErrorsEnabled, MAX_ARTIFACT_BYTES } from './errors.service';
export { sweepErrorSpikes } from './spikes';
export { ensureProject, getProject, listProjects, buildDsn, type ErrorProjectView } from './projects';
export { augmentSpecsForErrors, injectErrors, specsRequestErrors, ERRORS_ENABLED_LABEL } from './injection';
export { MAX_DECOMPRESSED_BYTES } from './envelope';
