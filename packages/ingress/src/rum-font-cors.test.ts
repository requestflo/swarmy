import { describe, expect, it } from 'bun:test';
import { caddyReplayFontCors, caddyRumHandle, RouteRumSchema } from './rum';

/** QA-057: replays load the recorded app's fonts from the dashboard origin. */
const rum = (over: Record<string, unknown>) =>
  RouteRumSchema.parse({ upstream: 'swarmy_controller:3021', token: 'abc.def', ...over });

describe('replay font CORS', () => {
  it('routes recording replays let the dashboard load their fonts (only when the app sets no ACAO)', () => {
    const lines = caddyRumHandle(rum({ mode: 'identified', replaySampleRate: 0.5 }));
    expect(lines).toContain('  @swarmy_replay_fonts path *.woff2 *.woff *.ttf *.otf *.eot');
    expect(lines).toContain('  header @swarmy_replay_fonts ?Access-Control-Allow-Origin *');
  });

  it('analytics-only or replay-off routes change nothing', () => {
    expect(caddyReplayFontCors(rum({ mode: 'analytics' }))).toEqual([]);
    expect(caddyReplayFontCors(rum({ mode: 'identified', replaySampleRate: 0 }))).toEqual([]);
  });
});
