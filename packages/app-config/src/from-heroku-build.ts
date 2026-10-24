/**
 * Heroku buildpacks → one Railpack `build:` for {@link fromHeroku}. Pure.
 *
 * Railpack detects the language the way the first buildpack did, so official
 * language buildpacks need nothing; a second language becomes a mise package
 * (`packages: [node]`), and a few well-known extras become apt packages.
 * Anything else is a gap: Railpack has no buildpacks.
 */
import type { HerokuGap } from './from-heroku-addons';

export interface BuildConversion {
  build: Record<string, unknown>;
  changes: string[];
  gaps: HerokuGap[];
}

/** Official language buildpacks Railpack builds itself → the mise tool for a second language. */
const LANGUAGES: Record<string, string | null> = {
  nodejs: 'node',
  python: 'python',
  ruby: 'ruby',
  go: 'go',
  php: 'php',
  java: 'java',
  gradle: 'java',
  jvm: 'java',
  static: null,
};
const NO_RAILPACK = new Set(['scala', 'clojure']);

/** `heroku/nodejs`, `heroku-community/apt`, `https://github.com/heroku/heroku-buildpack-ruby` → `nodejs`, `apt`, `ruby`. */
export function buildpackId(url: string): string {
  const last = url.replace(/\.git$/, '').replace(/[#?].*$/, '').split('/').filter(Boolean).pop() ?? url;
  return last.toLowerCase().replace(/^heroku-buildpack-/, '');
}

const APT: Array<[RegExp, string]> = [
  [/ffmpeg/, 'ffmpeg'],
  [/imagemagick/, 'imagemagick'],
  [/libvips|vips/, 'libvips'],
  [/poppler/, 'poppler-utils'],
];

export function convertBuildpacks(buildpacks: string[], path: string): BuildConversion {
  const c: BuildConversion = { build: { type: 'railpack', path }, changes: [], gaps: [] };
  const packages: string[] = [];
  const apt: string[] = [];
  let language: string | null = null;
  for (const url of buildpacks) {
    const id = buildpackId(url);
    const key = `buildpacks: ${url}`;
    if (id in LANGUAGES) {
      const tool = LANGUAGES[id];
      if (language === null) {
        language = id;
        c.gaps.push({ key, reason: 'Railpack detects the language and builds it the way the buildpack did', handled: true });
      } else if (tool && !packages.includes(tool)) {
        packages.push(tool);
        c.changes.push(`${url} is a second language, so the build adds it as a tool (build.packages: ${tool}).`);
      }
      continue;
    }
    if (NO_RAILPACK.has(id)) {
      c.gaps.push({ key, reason: `Railpack doesn't build ${id}: add a Dockerfile and swarmy builds that instead (build.type: dockerfile)` });
      continue;
    }
    const pkg = APT.find(([re]) => re.test(id))?.[1];
    if (pkg) {
      if (!apt.includes(pkg)) apt.push(pkg);
      c.changes.push(`${url} becomes an apt package in the image (build.apt: ${pkg}).`);
      continue;
    }
    const reason =
      id === 'apt'
        ? "Railpack takes apt packages in build.apt: list the Aptfile's packages there"
        : id.includes('pgbouncer')
          ? "swarmy's managed Postgres takes the app's connections directly: drop the pgbouncer wrapper from the start command"
          : `Railpack has no buildpacks: whatever ${id} added needs build.apt, build.packages or a Dockerfile`;
    c.gaps.push({ key, reason });
  }
  if (packages.length) c.build.packages = packages;
  if (apt.length) c.build.apt = apt;
  if (!buildpacks.length) c.changes.push('No buildpacks listed: Railpack detects the language from the repo, as Heroku did.');
  return c;
}
