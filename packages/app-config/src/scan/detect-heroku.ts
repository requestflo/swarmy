/**
 * "Looks like a Heroku app": a folder with a Procfile next to a Heroku
 * `app.json` (one that says formation, addons, buildpacks, env, scripts,
 * stack or environments — an Expo `app.json` doesn't count). Pure. The scan
 * hands what it found to {@link fromHeroku}, whose swarmy.yaml is the draft.
 */
import { at, ev, procfileEntries } from './files';
import type { Evidence, ScanFile } from './types';

export interface HerokuFound {
  /** The Procfile's processes and the app.json lines that gave it away. */
  evidence: Evidence[];
  /** The files' text, for `fromHeroku`. */
  appJson: string;
  procfile: string;
  /** Process types in the Procfile, in order. */
  processes: string[];
}

const HEROKU_KEY = /"(formation|addons|buildpacks|env|scripts|stack|environments)"\s*:/;
const textOf = (f: ScanFile): string => f.lines.map((l) => l.text).join('\n');

export function detectHeroku(files: ScanFile[], dir = ''): HerokuFound | null {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const appJson = byPath.get(at(dir, 'app.json'));
  const procfile = byPath.get(at(dir, 'Procfile'));
  if (!appJson || !procfile) return null;
  const keys = appJson.lines.filter((l) => HEROKU_KEY.test(l.text));
  const procs = procfileEntries(procfile);
  if (!keys.length || !procs.length) return null;
  const addons = appJson.lines.find((l) => /heroku-(postgresql|redis)|"addons"\s*:/.test(l.text));
  const evidence = [...procs.slice(0, 3).map((p) => ev(procfile, p.line)), ev(appJson, addons ?? keys[0]!)];
  return { evidence, appJson: textOf(appJson), procfile: textOf(procfile), processes: procs.map((p) => p.name) };
}
