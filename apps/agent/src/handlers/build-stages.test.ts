import { describe, expect, it } from 'bun:test';
import type { BuildImagePayload } from '@swarmy/core/protocol';
import { renderBuildProgram, splitMetaLines } from './build';
import { buildStageTracker } from './build-stages';

const CMD_ID = '00000000-0000-4000-8000-000000000001';
const payload = (over: Partial<BuildImagePayload> = {}): BuildImagePayload => ({
  commandId: CMD_ID,
  source: { url: 'https://github.com/o/r', ref: 'main' },
  imageRefs: ['localhost:5000/o-r:main'],
  pushPolicy: 'always',
  builder: 'dockerfile',
  ...over,
});

function track(): { entered: string[]; t: ReturnType<typeof buildStageTracker> } {
  const entered: string[] = [];
  return { entered, t: buildStageTracker((s) => entered.push(s)) };
}

describe('buildStageTracker', () => {
  it('reports clone, build, then push from the markers and BuildKit plain progress', () => {
    const { entered, t } = track();
    t.meta('stage clone');
    t.text("Cloning into '/home/user/workspace'...\n");
    t.meta('stage build');
    t.text('#7 [build 2/2] RUN pnpm build\n#7 DONE 30.4s\n');
    t.text('#9 exporting to image\n#9 exporting layers 1.2s done\n#9 pushing layers\n');
    t.text('#9 pushing manifest for localhost:5000/o-r:main@sha256:abc\n');
    expect(entered).toEqual(['clone', 'build', 'push']);
    expect(t.current).toBe('push');
  });

  it('never reopens an earlier stage or repeats one', () => {
    const { entered, t } = track();
    t.meta('stage build');
    t.meta('stage clone');
    t.meta('stage build');
    expect(entered).toEqual(['build']);
  });

  it('ignores a pushing line before the build stage, and other meta kinds', () => {
    const { entered, t } = track();
    t.meta('builder railpack');
    t.text('#3 pushing layers\n');
    t.meta('stage clone');
    t.text('#3 pushing layers\n');
    expect(entered).toEqual(['clone']);
  });

  it('only reads a pushing line at the start of a line', () => {
    const { entered, t } = track();
    t.meta('stage build');
    t.text('echo "#9 pushing layers" is in my build script\n');
    expect(entered).toEqual(['build']);
  });
});

describe('renderBuildProgram stage markers', () => {
  it('adds no markers unless the controller asked (the program is unchanged)', () => {
    expect(renderBuildProgram(payload())).not.toContain('SWARMY_META stage');
    expect(renderBuildProgram(payload({ reportStages: false }))).toBe(renderBuildProgram(payload()));
  });

  it('marks clone before the git fetch and build after it, before buildkitd starts', () => {
    const lines = renderBuildProgram(payload({ reportStages: true })).split('\n');
    const clone = lines.indexOf('echo "SWARMY_META stage clone"');
    const git = lines.findIndex((l) => l.startsWith('git clone'));
    const build = lines.indexOf('echo "SWARMY_META stage build"');
    const buildkitd = lines.findIndex((l) => l.includes('rootlesskit buildkitd'));
    expect(clone).toBeGreaterThan(-1);
    expect(clone).toBeLessThan(git);
    expect(git).toBeLessThan(build);
    expect(build).toBeLessThan(buildkitd);
  });

  it('the markers are captured as meta, never forwarded to the log', () => {
    const out = splitMetaLines('', 'SWARMY_META stage clone\nCloning…\nSWARMY_META stage build\n');
    expect(out.metas).toEqual(['stage clone', 'stage build']);
    expect(out.forward).toBe('Cloning…\n');
  });
});
