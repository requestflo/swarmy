/**
 * Stamp the self-host installer (`scripts/install-swarmy.sh`) with ONE
 * release's pins — security review M14: the installer defaulted to the
 * floating `:latest` controller/agent images and fetched `main`'s stack file.
 *
 * CI's Images workflow builds `platform.json` from the BOM
 * (`packages/core/src/system-images.ts`), so the controller and agent there
 * carry the release's tag and index digest. `installerReleasePins` turns those
 * into `<repo>:<tag>@<digest>`; this module writes them, and the release's own
 * `deploy/swarmy.lite.stack.yml`, between the installer's
 * `>>> swarmy release pins` markers. The stamped copy is published next to
 * `platform.json` (`<feed>/<channel>/install-swarmy.sh`): one download carries
 * everything it deploys, so nothing it installs floats or is fetched from a
 * moving branch. The checked-in script keeps the empty block (not a release
 * build: it warns and floats).
 *
 * Pure: no I/O (`scripts/stamp-install-swarmy.ts` does the reading/writing).
 */
import type { InstallerReleasePins } from '@swarmy/core/platform-manifest';

export const RELEASE_PINS_BEGIN = '# >>> swarmy release pins (stamped at release by scripts/stamp-install-swarmy.ts)';
export const RELEASE_PINS_END = '# <<< swarmy release pins';
export const RELEASE_STACK_EOF = 'SWARMY_RELEASE_STACK_EOF';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PINNED_REF = /^[a-z0-9]+(?:[._:/-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}@sha256:[a-f0-9]{64}$/;

/** The pins block: empty (the checked-in script) or one release's values. */
export function renderReleasePins(pins: InstallerReleasePins | null, stackYaml = ''): string {
  if (!pins) {
    return [
      RELEASE_PINS_BEGIN,
      'RELEASE_VERSION=""',
      'RELEASE_CONTROLLER_IMAGE=""',
      'RELEASE_AGENT_IMAGE=""',
      'release_stack() { return 1; }',
      RELEASE_PINS_END,
    ].join('\n');
  }
  if (!SEMVER.test(pins.version)) throw new Error(`release version is not semver: ${pins.version}`);
  if (pins.commit && !/^[0-9a-f]{7,40}$/.test(pins.commit)) throw new Error(`release commit is not a git sha: ${pins.commit}`);
  for (const [what, ref] of [
    ['controller', pins.controllerImage],
    ['agent', pins.agentImage],
  ] as const) {
    if (!PINNED_REF.test(ref)) throw new Error(`${what} image is not pinned as <repo>:<tag>@sha256:<digest>: ${ref}`);
  }
  if (!stackYaml.trim()) throw new Error('the release stack file is empty');
  const yaml = stackYaml.endsWith('\n') ? stackYaml : `${stackYaml}\n`;
  if (yaml.split('\n').includes(RELEASE_STACK_EOF)) throw new Error(`the stack file contains the heredoc delimiter ${RELEASE_STACK_EOF}`);
  return [
    RELEASE_PINS_BEGIN,
    `# release ${pins.version}${pins.commit ? ` (commit ${pins.commit})` : ''}`,
    `RELEASE_VERSION="${pins.version}"`,
    `RELEASE_CONTROLLER_IMAGE="${pins.controllerImage}"`,
    `RELEASE_AGENT_IMAGE="${pins.agentImage}"`,
    'release_stack() {',
    `  cat <<'${RELEASE_STACK_EOF}'`,
    `${yaml}${RELEASE_STACK_EOF}`,
    '}',
    RELEASE_PINS_END,
  ].join('\n');
}

/** The installer with its (empty) pins block replaced by this release's. */
export function stampInstallSwarmy(script: string, pins: InstallerReleasePins, stackYaml: string): string {
  const begin = script.indexOf(`${RELEASE_PINS_BEGIN}\n`);
  const end = script.indexOf(`${RELEASE_PINS_END}\n`, begin);
  if (begin < 0 || end < 0) throw new Error('install-swarmy.sh has no release pins block');
  if (script.indexOf(RELEASE_PINS_BEGIN, begin + 1) >= 0) throw new Error('install-swarmy.sh has more than one release pins block');
  return script.slice(0, begin) + renderReleasePins(pins, stackYaml) + script.slice(end + RELEASE_PINS_END.length);
}
