import { describe, expect, it } from 'bun:test';
import { isLogStage, lineStages, stageLineCounts } from './build-log-stages';

const t = (...texts: string[]) => texts.map((text) => ({ text }));

describe('lineStages: clone → build → push from the log itself', () => {
  it('splits a whole build where the agent reports each stage', () => {
    const lines = t(
      "Cloning into '/work/src'...",
      '#1 [internal] load build definition from Dockerfile',
      '#5 [build 3/3] RUN pnpm build',
      '#9 exporting to image',
      '#9 exporting layers 1.1s done',
      '#9 pushing layers 0.8s done',
      '#9 pushing manifest for localhost:5000/shop:main 0.2s done',
      'SWARMY_DIGEST=sha256:abc',
    );
    expect(lineStages(lines)).toEqual(['clone', 'build', 'build', 'build', 'build', 'push', 'push', 'push']);
    expect(stageLineCounts(lineStages(lines))).toEqual({ clone: 1, build: 4, push: 3 });
  });

  it("a build that never got to BuildKit is all clone; buildkitd's own failure is the build's", () => {
    expect(lineStages(t("Cloning into '/w'...", 'fatal: repository not found'))).toEqual(['clone', 'clone']);
    expect(lineStages(t("Cloning into '/w'...", 'buildkitd did not become ready within 30s'))).toEqual(['clone', 'build']);
  });

  it('never reopens an earlier stage, and git output that says "pushing" is still the clone', () => {
    expect(lineStages(t('remote: pushing layers is not a thing git says', '#3 [x] RUN y'))).toEqual(['clone', 'build']);
    expect(lineStages(t('#3 [x] RUN y', '#4 pushing manifest for a', '#5 [late] noise'))).toEqual(['build', 'push', 'push']);
  });

  it('knows which rail stages have log lines', () => {
    expect(isLogStage('push')).toBe(true);
    expect(isLogStage('scan')).toBe(false);
  });
});
